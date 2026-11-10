-- Hotel Punta Serena: datos de prueba
--
-- Todos los datos son ficticios. Los correos usan el dominio reservado
-- example.com y no pertenecen a nadie. Se ejecuta después de schema.sql,
-- conectado como postgres. Las fechas de las reservas se calculan a partir del
-- día en que se ejecuta, en hora de Costa Rica, para que la ocupación del día
-- siempre tenga llegadas, salidas y huéspedes hospedados.
--
-- No crea usuarios internos: el primero se crea con api/src/crear_usuario.js,
-- que genera una contraseña aleatoria y la muestra una sola vez.

BEGIN;

INSERT INTO hotel.tipos_habitacion (nombre, capacidad, descripcion) VALUES
  ('Estándar', 2, 'Cama matrimonial, baño privado y aire acondicionado'),
  ('Familiar', 4, 'Dos camas matrimoniales, baño privado y aire acondicionado');

-- Catorce habitaciones: ocho estándar (101 a 108) y seis familiares (201 a 206).
INSERT INTO hotel.habitaciones (numero, tipo_id)
SELECT n::text, (SELECT id FROM hotel.tipos_habitacion WHERE nombre = 'Estándar')
FROM generate_series(101, 108) AS n;
INSERT INTO hotel.habitaciones (numero, tipo_id)
SELECT n::text, (SELECT id FROM hotel.tipos_habitacion WHERE nombre = 'Familiar')
FROM generate_series(201, 206) AS n;

-- Temporada alta de diciembre a abril y en julio. Rangos [inicio, fin).
INSERT INTO hotel.temporadas (nombre, fecha_inicio, fecha_fin) VALUES
  ('Baja 2026',       '2026-08-01', '2026-12-01'),
  ('Alta 2026-2027',  '2026-12-01', '2027-05-01'),
  ('Baja 2027',       '2027-05-01', '2027-07-01'),
  ('Alta julio 2027', '2027-07-01', '2027-08-01'),
  ('Baja agosto 2027','2027-08-01', '2027-12-01'),
  ('Alta 2027-2028',  '2027-12-01', '2028-05-01');

-- Precio por noche en USD: estándar 65 en baja y 95 en alta; familiar 95 y 140.
INSERT INTO hotel.tarifas (tipo_id, temporada_id, precio_noche)
SELECT th.id, t.id,
       CASE WHEN th.nombre = 'Estándar' AND t.nombre LIKE 'Baja%' THEN 65
            WHEN th.nombre = 'Estándar'                         THEN 95
            WHEN t.nombre LIKE 'Baja%'                          THEN 95
            ELSE 140 END
FROM hotel.tipos_habitacion th CROSS JOIN hotel.temporadas t;

INSERT INTO hotel.huespedes (nombre_completo, correo, telefono, tipo_documento, numero_documento, consentimiento_en) VALUES
  ('Lucía Prueba Mora',       'lucia.prueba@example.com',   '+506 8000 0001', 'cedula',    '100000001', now()),
  ('Daniel Ficticio Rojas',   'daniel.ficticio@example.com','+506 8000 0002', NULL,        NULL,        now()),
  ('Anna Muster',             'anna.muster@example.com',    '+49 30 000 0003', 'pasaporte', 'X0000003',  now()),
  ('Carlos Ejemplo Vargas',   'carlos.ejemplo@example.com', '+506 8000 0004', NULL,        NULL,        now()),
  ('Sofía Demo Jiménez',      'sofia.demo@example.com',     '+506 8000 0005', 'cedula',    '100000005', now());

-- Total pactado: suma de la tarifa de cada noche según su temporada.
CREATE FUNCTION pg_temp.total(p_habitacion text, p_entrada date, p_salida date)
RETURNS numeric LANGUAGE sql AS $$
  SELECT sum(t.precio_noche)
  FROM generate_series(p_entrada, p_salida - 1, interval '1 day') AS n(dia)
  JOIN hotel.temporadas s ON n.dia::date >= s.fecha_inicio AND n.dia::date < s.fecha_fin
  JOIN hotel.habitaciones h ON h.numero = p_habitacion
  JOIN hotel.tarifas t ON t.temporada_id = s.id AND t.tipo_id = h.tipo_id
$$;

DO $$
DECLARE
  hoy date := (now() AT TIME ZONE 'America/Costa_Rica')::date;
  zona text := 'America/Costa_Rica';
BEGIN
  INSERT INTO hotel.reservas
    (codigo, habitacion_id, huesped_id, fecha_entrada, fecha_salida, personas,
     tarifa_aplicada, estado, checkin_en, checkout_en, correo_pendiente)
  VALUES
    -- Hospedada: llegó hace dos días y sale mañana.
    ('K7M2Q9XA', (SELECT id FROM hotel.habitaciones WHERE numero = '101'),
     (SELECT id FROM hotel.huespedes WHERE correo = 'lucia.prueba@example.com'),
     hoy - 2, hoy + 1, 2, pg_temp.total('101', hoy - 2, hoy + 1), 'en_curso',
     ((hoy - 2) + time '14:35') AT TIME ZONE zona, NULL, false),
    -- Llega hoy.
    ('HB4T8NWE', (SELECT id FROM hotel.habitaciones WHERE numero = '102'),
     (SELECT id FROM hotel.huespedes WHERE correo = 'daniel.ficticio@example.com'),
     hoy, hoy + 3, 2, pg_temp.total('102', hoy, hoy + 3), 'confirmada',
     NULL, NULL, false),
    -- Sale hoy: sigue hospedada hasta registrar el check out.
    ('R3DZ6PLC', (SELECT id FROM hotel.habitaciones WHERE numero = '201'),
     (SELECT id FROM hotel.huespedes WHERE correo = 'anna.muster@example.com'),
     hoy - 3, hoy, 3, pg_temp.total('201', hoy - 3, hoy), 'en_curso',
     ((hoy - 3) + time '15:10') AT TIME ZONE zona, NULL, false),
    -- Futura, con el correo de confirmación pendiente de reenviar.
    ('F9G2VJ5S', (SELECT id FROM hotel.habitaciones WHERE numero = '103'),
     (SELECT id FROM hotel.huespedes WHERE correo = 'carlos.ejemplo@example.com'),
     hoy + 10, hoy + 14, 2, pg_temp.total('103', hoy + 10, hoy + 14), 'confirmada',
     NULL, NULL, true),
    -- Cancelada: no bloquea la habitación 102 aunque sus fechas se traslapan.
    ('W8Y3KM7T', (SELECT id FROM hotel.habitaciones WHERE numero = '102'),
     (SELECT id FROM hotel.huespedes WHERE correo = 'carlos.ejemplo@example.com'),
     hoy + 1, hoy + 2, 1, pg_temp.total('102', hoy + 1, hoy + 2), 'cancelada',
     NULL, NULL, false),
    -- Finalizada la semana pasada.
    ('P5C4XQ2R', (SELECT id FROM hotel.habitaciones WHERE numero = '104'),
     (SELECT id FROM hotel.huespedes WHERE correo = 'sofia.demo@example.com'),
     hoy - 7, hoy - 4, 2, pg_temp.total('104', hoy - 7, hoy - 4), 'finalizada',
     ((hoy - 7) + time '14:05') AT TIME ZONE zona, ((hoy - 4) + time '11:40') AT TIME ZONE zona, false);

  -- Cada reserva tiene al menos su registro de creación en la bitácora.
  INSERT INTO hotel.bitacora (reserva_id, accion, detalle)
  SELECT id, 'crear', jsonb_build_object('origen', 'datos de prueba') FROM hotel.reservas;
  INSERT INTO hotel.bitacora (reserva_id, accion)
  SELECT id, 'checkin' FROM hotel.reservas WHERE checkin_en IS NOT NULL;
  INSERT INTO hotel.bitacora (reserva_id, accion)
  SELECT id, 'checkout' FROM hotel.reservas WHERE checkout_en IS NOT NULL;
  INSERT INTO hotel.bitacora (reserva_id, accion)
  SELECT id, 'cancelar' FROM hotel.reservas WHERE estado = 'cancelada';
END
$$;

COMMIT;
