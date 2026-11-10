-- Hotel Punta Serena: esquema de la base de datos (PostgreSQL 17 en Supabase)
--
-- Se ejecuta una sola vez, conectado como el usuario postgres del proyecto
-- (editor SQL de Supabase o psql). No contiene contraseñas: las de los roles
-- api_hotel y respaldo_hotel se asignan después con \password desde psql.
--
-- Las tablas viven en el esquema propio "hotel" y no en "public", para que la
-- API de datos de Supabase no las exponga. Solo la API del hotel llega a ellas.

BEGIN;

-- La extensión btree_gist permite combinar la igualdad de habitacion_id con el
-- traslape de rangos de fechas dentro de una misma restricción de exclusión.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

CREATE SCHEMA hotel;

-- Catálogo de habitaciones ----------------------------------------------------

CREATE TABLE hotel.tipos_habitacion (
  id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre      text     NOT NULL UNIQUE,
  capacidad   smallint NOT NULL CHECK (capacidad BETWEEN 1 AND 8),
  descripcion text
);

CREATE TABLE hotel.habitaciones (
  id      smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero  text     NOT NULL UNIQUE,
  tipo_id smallint NOT NULL REFERENCES hotel.tipos_habitacion (id),
  activa  boolean  NOT NULL DEFAULT true
);

-- Temporadas y tarifas --------------------------------------------------------
-- Las temporadas usan el rango semiabierto [fecha_inicio, fecha_fin): la fecha
-- de fin es el primer día que ya no pertenece a la temporada.

CREATE TABLE hotel.temporadas (
  id           smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre       text NOT NULL,
  fecha_inicio date NOT NULL,
  fecha_fin    date NOT NULL,
  CONSTRAINT temporadas_fechas_validas CHECK (fecha_fin > fecha_inicio),
  CONSTRAINT temporadas_sin_traslape EXCLUDE USING gist (
    daterange(fecha_inicio, fecha_fin, '[)') WITH &&
  )
);

CREATE TABLE hotel.tarifas (
  tipo_id      smallint      NOT NULL REFERENCES hotel.tipos_habitacion (id),
  temporada_id smallint      NOT NULL REFERENCES hotel.temporadas (id),
  precio_noche numeric(10,2) NOT NULL CHECK (precio_noche > 0),   -- USD
  PRIMARY KEY (tipo_id, temporada_id)
);

-- Usuarios internos -----------------------------------------------------------

CREATE TABLE hotel.usuarios (
  id              smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre          text        NOT NULL,
  usuario         text        NOT NULL UNIQUE,
  hash_contrasena text        NOT NULL,                 -- Argon2id, nunca texto plano
  rol             text        NOT NULL CHECK (rol IN ('recepcion', 'administracion')),
  activo          boolean     NOT NULL DEFAULT true,
  creado_en       timestamptz NOT NULL DEFAULT now()
);

-- Huéspedes (Ley 8968: solo los datos necesarios) ------------------------------
-- Al reservar se piden nombre, correo y teléfono. El documento de identidad lo
-- registra recepción en el check in. consentimiento_en guarda cuándo aceptó el
-- tratamiento de sus datos.

CREATE TABLE hotel.huespedes (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre_completo   text        NOT NULL,
  correo            text        NOT NULL,
  telefono          text        NOT NULL,
  tipo_documento    text        CHECK (tipo_documento IN ('cedula', 'dimex', 'pasaporte')),
  numero_documento  text,
  consentimiento_en timestamptz NOT NULL,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT huespedes_documento_completo CHECK ((tipo_documento IS NULL) = (numero_documento IS NULL)),
  CONSTRAINT huespedes_documento_unico UNIQUE (tipo_documento, numero_documento)
);

-- Un correo identifica a un huésped sin distinguir mayúsculas.
CREATE UNIQUE INDEX huespedes_correo_unico ON hotel.huespedes (lower(correo));

-- Reservas --------------------------------------------------------------------
-- fecha_entrada y fecha_salida forman el rango semiabierto [entrada, salida):
-- la noche de la fecha de salida no se ocupa, por eso una salida y una entrada
-- del mismo día en la misma habitación no chocan.

CREATE TABLE hotel.reservas (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo           char(8)       NOT NULL UNIQUE
                   CHECK (codigo ~ '^[A-HJ-NP-Z2-9]{8}$'),   -- sin O, 0, I ni 1
  habitacion_id    smallint      NOT NULL REFERENCES hotel.habitaciones (id),
  huesped_id       bigint        NOT NULL REFERENCES hotel.huespedes (id),
  fecha_entrada    date          NOT NULL,
  fecha_salida     date          NOT NULL,
  personas         smallint      NOT NULL CHECK (personas >= 1),
  tarifa_aplicada  numeric(10,2) NOT NULL CHECK (tarifa_aplicada > 0),   -- total pactado en USD
  estado           text          NOT NULL DEFAULT 'confirmada'
                   CHECK (estado IN ('confirmada', 'en_curso', 'finalizada', 'cancelada')),
  checkin_en       timestamptz,
  checkout_en      timestamptz,
  correo_pendiente boolean       NOT NULL DEFAULT true,
  version          integer       NOT NULL DEFAULT 1,       -- bloqueo optimista
  creado_por       smallint      REFERENCES hotel.usuarios (id),   -- nulo: reserva del huésped en la web
  modificado_por   smallint      REFERENCES hotel.usuarios (id),
  creado_en        timestamptz   NOT NULL DEFAULT now(),
  modificado_en    timestamptz,
  CONSTRAINT reservas_fechas_validas CHECK (fecha_salida > fecha_entrada),
  CONSTRAINT reservas_checkin_registrado
    CHECK (estado NOT IN ('en_curso', 'finalizada') OR checkin_en IS NOT NULL),
  CONSTRAINT reservas_checkout_registrado
    CHECK (estado <> 'finalizada' OR checkout_en IS NOT NULL),
  -- RF03: ninguna reserva no cancelada puede traslaparse con otra en la misma
  -- habitación. Es el árbitro final ante inserciones simultáneas.
  CONSTRAINT reservas_sin_traslape EXCLUDE USING gist (
    habitacion_id WITH =,
    daterange(fecha_entrada, fecha_salida, '[)') WITH &&
  ) WHERE (estado <> 'cancelada')
);

CREATE INDEX reservas_fecha_entrada_idx ON hotel.reservas (fecha_entrada);
CREATE INDEX reservas_fecha_salida_idx  ON hotel.reservas (fecha_salida);
CREATE INDEX reservas_huesped_idx       ON hotel.reservas (huesped_id);

-- Bitácora (RNF10) ------------------------------------------------------------

CREATE TABLE hotel.bitacora (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reserva_id    bigint      NOT NULL REFERENCES hotel.reservas (id),
  usuario_id    smallint    REFERENCES hotel.usuarios (id),   -- nulo: acción del huésped en la web
  accion        text        NOT NULL
                CHECK (accion IN ('crear', 'modificar', 'cancelar', 'checkin', 'checkout')),
  detalle       jsonb,
  registrado_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bitacora_reserva_idx ON hotel.bitacora (reserva_id);

-- Roles de mínimo privilegio --------------------------------------------------
-- Se crean sin contraseña. Desde psql, conectado como postgres:
--   \password api_hotel
--   \password respaldo_hotel

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_hotel') THEN
    CREATE ROLE api_hotel LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'respaldo_hotel') THEN
    CREATE ROLE respaldo_hotel LOGIN;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA hotel FROM PUBLIC;

-- Supabase crea los roles anon y authenticated; se les niega todo acceso.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA hotel FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA hotel FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- api_hotel: lee y escribe lo que la aplicación necesita. No puede borrar filas,
-- no puede crear ni modificar tablas, y en la bitácora solo puede insertar.
GRANT USAGE ON SCHEMA hotel TO api_hotel;
GRANT SELECT, INSERT, UPDATE ON
  hotel.tipos_habitacion, hotel.habitaciones, hotel.temporadas, hotel.tarifas,
  hotel.usuarios, hotel.huespedes, hotel.reservas
  TO api_hotel;
GRANT SELECT, INSERT ON hotel.bitacora TO api_hotel;

-- respaldo_hotel: solo lectura, para pg_dump. Sus sesiones son de solo lectura.
GRANT USAGE ON SCHEMA hotel TO respaldo_hotel;
GRANT SELECT ON ALL TABLES IN SCHEMA hotel TO respaldo_hotel;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA hotel TO respaldo_hotel;
ALTER ROLE respaldo_hotel SET default_transaction_read_only = on;

-- Límite de tiempo por consulta para la API (apoya RNF07).
ALTER ROLE api_hotel SET statement_timeout = '5s';

COMMIT;
