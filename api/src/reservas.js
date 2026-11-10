// Reservas: disponibilidad (RF01), registro (RF02, RF03, RF04), modificación y
// cancelación (RF05), check in y check out (RF06) y ocupación del día (RF11).
//
// RF03 no depende de este código: la restricción de exclusión de la base
// rechaza cualquier traslape, aunque lleguen dos peticiones en el mismo
// instante o las atiendan réplicas distintas de la API.

const crypto = require('node:crypto');
const express = require('express');
const { consultar, enTransaccion, HOY } = require('./db');
const { ErrorHttp } = require('./errores');
const { autenticar, autenticarOpcional } = require('./auth');
const { permitir } = require('./roles');
const { enviarConfirmacion } = require('./correo');
const v = require('./validacion');

const router = express.Router();
const HORA_ENTRADA = process.env.HORA_ENTRADA || '14:00';
const HORA_SALIDA = process.env.HORA_SALIDA || '12:00';

// Código aleatorio y no secuencial: 32 símbolos sin O, 0, I ni 1.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function nuevoCodigo() {
  let codigo = '';
  for (let i = 0; i < 8; i += 1) codigo += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return codigo;
}

// Total de la estancia: suma de la tarifa de cada noche según su temporada.
async function calcularTotal(cliente, tipoId, entrada, salida) {
  const { rows } = await cliente.query(
    `SELECT count(*)::int AS noches, count(t.precio_noche)::int AS con_tarifa, sum(t.precio_noche) AS total
       FROM generate_series($1::date, $2::date - 1, interval '1 day') AS n(dia)
       LEFT JOIN hotel.temporadas s ON n.dia::date >= s.fecha_inicio AND n.dia::date < s.fecha_fin
       LEFT JOIN hotel.tarifas t ON t.temporada_id = s.id AND t.tipo_id = $3`,
    [entrada, salida, tipoId],
  );
  const r = rows[0];
  if (r.con_tarifa !== r.noches) throw new ErrorHttp(400, 'No hay tarifa definida para todas las noches solicitadas.');
  return r.total;
}

async function habitacionParaReservar(cliente, habitacionId, personas) {
  const { rows } = await cliente.query(
    `SELECT h.id, h.numero, h.activa, th.id AS tipo_id, th.nombre AS tipo, th.capacidad
       FROM hotel.habitaciones h JOIN hotel.tipos_habitacion th ON th.id = h.tipo_id
      WHERE h.id = $1`,
    [habitacionId],
  );
  const h = rows[0];
  if (!h || !h.activa) throw new ErrorHttp(404, 'La habitación no existe o no está disponible.');
  if (personas > h.capacidad) throw new ErrorHttp(400, `La habitación admite como máximo ${h.capacidad} personas.`);
  return h;
}

// Datos completos de una reserva para recepción y para el correo.
const SELECT_RESERVA = `
  SELECT r.id, r.codigo, r.estado, r.fecha_entrada, r.fecha_salida, r.personas,
         r.tarifa_aplicada, r.checkin_en, r.checkout_en, r.correo_pendiente, r.version,
         r.habitacion_id, h.numero, th.nombre AS tipo, th.id AS tipo_id,
         hu.id AS huesped_id, hu.nombre_completo, hu.correo, hu.telefono
    FROM hotel.reservas r
    JOIN hotel.habitaciones h ON h.id = r.habitacion_id
    JOIN hotel.tipos_habitacion th ON th.id = h.tipo_id
    JOIN hotel.huespedes hu ON hu.id = r.huesped_id`;

async function buscarPorCodigo(cliente, codigo) {
  const { rows } = await cliente.query(`${SELECT_RESERVA} WHERE r.codigo = $1`, [codigo]);
  if (!rows[0]) throw new ErrorHttp(404, 'No existe una reserva con ese código.');
  return rows[0];
}

function exigirVersion(reserva, version) {
  if (reserva.version !== version) {
    throw new ErrorHttp(409, 'La reserva cambió desde que la abrió. Recargue para ver los datos actuales.');
  }
}

function registrarBitacora(cliente, reservaId, usuarioId, accion, detalle = null) {
  return cliente.query(
    'INSERT INTO hotel.bitacora (reserva_id, usuario_id, accion, detalle) VALUES ($1, $2, $3, $4)',
    [reservaId, usuarioId, accion, detalle],
  );
}

function vistaReserva(r) {
  return {
    codigo: r.codigo,
    estado: r.estado,
    habitacion: { id: r.habitacion_id, numero: r.numero, tipo: r.tipo },
    huesped: { nombre_completo: r.nombre_completo, correo: r.correo, telefono: r.telefono },
    fecha_entrada: r.fecha_entrada,
    fecha_salida: r.fecha_salida,
    noches: v.diasEntre(r.fecha_entrada, r.fecha_salida),
    personas: r.personas,
    total: r.tarifa_aplicada,
    moneda: 'USD',
    checkin_en: r.checkin_en,
    checkout_en: r.checkout_en,
    correo_pendiente: r.correo_pendiente,
    version: r.version,
  };
}

// Tras confirmar la transacción se envía el correo. Si falla, la reserva no se
// afecta: solo queda marcada con correo pendiente.
async function enviarYMarcar(reserva) {
  const enviado = await enviarConfirmacion(reserva);
  if (enviado) {
    await consultar('UPDATE hotel.reservas SET correo_pendiente = false WHERE id = $1', [reserva.id])
      .catch((e) => console.warn('No se pudo marcar el correo como enviado:', e.message));
  }
  return enviado;
}

// GET /api/disponibilidad?entrada=AAAA-MM-DD&salida=AAAA-MM-DD&personas=N  (público, RF01)
router.get('/disponibilidad', async (req, res) => {
  const entrada = v.fecha(req.query.entrada, 'La fecha de entrada');
  const salida = v.fecha(req.query.salida, 'La fecha de salida');
  const personas = v.entero(req.query.personas, 'La cantidad de personas', { min: 1, max: 8 });
  if (entrada < v.hoyCostaRica()) throw v.invalido('La fecha de entrada no puede estar en el pasado.');
  const noches = v.estancia(entrada, salida);

  const { rows } = await consultar(
    `WITH noches AS (
       SELECT d::date AS dia FROM generate_series($1::date, $2::date - 1, interval '1 day') AS d
     ), precios AS (
       SELECT th.id AS tipo_id, count(t.precio_noche)::int AS con_tarifa, sum(t.precio_noche) AS total
         FROM hotel.tipos_habitacion th
        CROSS JOIN noches n
         LEFT JOIN hotel.temporadas s ON n.dia >= s.fecha_inicio AND n.dia < s.fecha_fin
         LEFT JOIN hotel.tarifas t ON t.temporada_id = s.id AND t.tipo_id = th.id
        GROUP BY th.id
     )
     SELECT h.id, h.numero, th.nombre AS tipo, th.capacidad, th.descripcion, p.total
       FROM hotel.habitaciones h
       JOIN hotel.tipos_habitacion th ON th.id = h.tipo_id
       JOIN precios p ON p.tipo_id = th.id
      WHERE h.activa
        AND th.capacidad >= $3
        AND p.con_tarifa = $4
        AND NOT EXISTS (
              SELECT 1 FROM hotel.reservas r
               WHERE r.habitacion_id = h.id
                 AND r.estado <> 'cancelada'
                 AND daterange(r.fecha_entrada, r.fecha_salida, '[)') && daterange($1::date, $2::date, '[)'))
      ORDER BY p.total, h.numero`,
    [entrada, salida, personas, noches],
  );
  res.json({
    fecha_entrada: entrada,
    fecha_salida: salida,
    noches,
    personas,
    hora_entrada: HORA_ENTRADA,
    hora_salida: HORA_SALIDA,
    moneda: 'USD',
    habitaciones: rows,
  });
});

// POST /api/reservas  (huésped sin cuenta o recepción con sesión; RF02, RF03, RF04)
router.post('/reservas', autenticarOpcional, async (req, res) => {
  // Con sesión, el rol debe poder gestionar reservas (recepción o administración).
  if (req.usuario) permitir('reservas.gestionar')(req, res, () => {});
  const cuerpo = v.soloCampos(req.body, ['habitacion_id', 'fecha_entrada', 'fecha_salida', 'personas', 'huesped', 'acepta_tratamiento_datos']);
  const habitacionId = v.entero(cuerpo.habitacion_id, 'La habitación', { min: 1, max: 32767 });
  const entrada = v.fecha(cuerpo.fecha_entrada, 'La fecha de entrada');
  const salida = v.fecha(cuerpo.fecha_salida, 'La fecha de salida');
  const personas = v.entero(cuerpo.personas, 'La cantidad de personas', { min: 1, max: 8 });
  if (entrada < v.hoyCostaRica()) throw v.invalido('La fecha de entrada no puede estar en el pasado.');
  v.estancia(entrada, salida);
  // Ley 8968: sin consentimiento expreso no se registran datos personales.
  if (cuerpo.acepta_tratamiento_datos !== true) {
    throw v.invalido('Debe aceptar el tratamiento de sus datos personales para reservar.');
  }
  const h = v.soloCampos(cuerpo.huesped ?? null, ['nombre_completo', 'correo', 'telefono']);
  const huesped = {
    nombre_completo: v.texto(h.nombre_completo, 'El nombre completo', { min: 3, max: 120 }),
    correo: v.correo(h.correo),
    telefono: v.telefono(h.telefono),
  };
  const usuarioId = req.usuario ? req.usuario.id : null;

  const reserva = await enTransaccion(async (c) => {
    const hab = await habitacionParaReservar(c, habitacionId, personas);
    const total = await calcularTotal(c, hab.tipo_id, entrada, salida);

    // Si el correo ya existe, la reserva se asocia a ese huésped sin modificar
    // sus datos: nadie puede cambiar los datos de otra persona desde la web.
    let { rows } = await c.query(
      `INSERT INTO hotel.huespedes (nombre_completo, correo, telefono, consentimiento_en)
       VALUES ($1, $2, $3, now())
       ON CONFLICT ((lower(correo))) DO NOTHING
       RETURNING id`,
      [huesped.nombre_completo, huesped.correo, huesped.telefono],
    );
    if (!rows[0]) ({ rows } = await c.query('SELECT id FROM hotel.huespedes WHERE lower(correo) = $1', [huesped.correo]));
    const huespedId = rows[0].id;

    // Un código repetido es muy improbable (32^8 combinaciones); si ocurre, se reintenta.
    let id;
    for (let intento = 1; !id; intento += 1) {
      await c.query('SAVEPOINT codigo');
      try {
        ({ rows } = await c.query(
          `INSERT INTO hotel.reservas
             (codigo, habitacion_id, huesped_id, fecha_entrada, fecha_salida, personas, tarifa_aplicada, creado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [nuevoCodigo(), hab.id, huespedId, entrada, salida, personas, total, usuarioId],
        ));
        id = rows[0].id;
      } catch (e) {
        if (e.code === '23505' && e.constraint === 'reservas_codigo_key' && intento < 3) {
          await c.query('ROLLBACK TO SAVEPOINT codigo');
        } else {
          throw e;
        }
      }
    }
    await registrarBitacora(c, id, usuarioId, 'crear', { origen: usuarioId ? 'recepcion' : 'web' });
    ({ rows } = await c.query(`${SELECT_RESERVA} WHERE r.id = $1`, [id]));
    return rows[0];
  });

  const enviado = await enviarYMarcar(reserva);
  res.status(201).location(`/api/reservas/${reserva.codigo}`).json({
    codigo: reserva.codigo,
    habitacion: { numero: reserva.numero, tipo: reserva.tipo },
    fecha_entrada: reserva.fecha_entrada,
    fecha_salida: reserva.fecha_salida,
    noches: v.diasEntre(reserva.fecha_entrada, reserva.fecha_salida),
    personas: reserva.personas,
    total: reserva.tarifa_aplicada,
    moneda: 'USD',
    hora_entrada: HORA_ENTRADA,
    hora_salida: HORA_SALIDA,
    correo_enviado: enviado,
  });
});

// A partir de aquí todo exige sesión de recepción o administración.
const interno = [autenticar, permitir('reservas.gestionar')];

// GET /api/reservas?codigo=XXXXXXXX  o  ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD
router.get('/reservas', interno, async (req, res) => {
  let resultado;
  if (req.query.codigo !== undefined) {
    resultado = await consultar(`${SELECT_RESERVA} WHERE r.codigo = $1`, [v.codigoReserva(req.query.codigo)]);
  } else {
    const desde = v.fecha(req.query.desde ?? v.hoyCostaRica(), 'La fecha desde');
    const hasta = v.fecha(req.query.hasta ?? v.sumarDias(desde, 30), 'La fecha hasta');
    if (hasta < desde || v.diasEntre(desde, hasta) > 366) throw v.invalido('El rango de fechas no es válido (máximo un año).');
    // Reservas cuya estancia toca el rango [desde, hasta].
    resultado = await consultar(
      `${SELECT_RESERVA} WHERE r.fecha_entrada <= $2 AND r.fecha_salida >= $1
        ORDER BY r.fecha_entrada, h.numero LIMIT 500`,
      [desde, hasta],
    );
  }
  res.json(resultado.rows.map(vistaReserva));
});

// GET /api/reservas/:codigo
router.get('/reservas/:codigo', interno, async (req, res) => {
  const { rows } = await consultar(`${SELECT_RESERVA} WHERE r.codigo = $1`, [v.codigoReserva(req.params.codigo)]);
  if (!rows[0]) throw new ErrorHttp(404, 'No existe una reserva con ese código.');
  res.json(vistaReserva(rows[0]));
});

// PATCH /api/reservas/:codigo  (RF05: modificar o cancelar; bloqueo optimista con version)
router.patch('/reservas/:codigo', interno, async (req, res) => {
  const codigo = v.codigoReserva(req.params.codigo);
  const cuerpo = v.soloCampos(req.body, ['version', 'estado', 'fecha_entrada', 'fecha_salida', 'personas', 'habitacion_id']);
  const version = v.entero(cuerpo.version, 'La versión', { min: 1, max: 2147483647 });
  const cambios = Object.keys(cuerpo).filter((k) => k !== 'version');
  if (!cambios.length) throw v.invalido('No se indicó ningún cambio.');
  const hoy = v.hoyCostaRica();

  const actualizada = await enTransaccion(async (c) => {
    const r = await buscarPorCodigo(c, codigo);
    exigirVersion(r, version);
    if (r.estado === 'cancelada' || r.estado === 'finalizada') {
      throw new ErrorHttp(409, `No se puede modificar una reserva ${r.estado}.`);
    }

    // Cancelación
    if (cuerpo.estado !== undefined) {
      v.uno(cuerpo.estado, 'El estado', ['cancelada']);
      if (cambios.length > 1) throw v.invalido('Al cancelar no se pueden cambiar otros datos.');
      if (r.estado !== 'confirmada') throw new ErrorHttp(409, 'Solo se puede cancelar una reserva confirmada; un huésped hospedado registra su salida.');
      const { rowCount } = await c.query(
        `UPDATE hotel.reservas SET estado = 'cancelada', version = version + 1,
                modificado_por = $1, modificado_en = now()
          WHERE id = $2 AND version = $3`,
        [req.usuario.id, r.id, version],
      );
      if (!rowCount) exigirVersion({ version: -1 }, version);
      await registrarBitacora(c, r.id, req.usuario.id, 'cancelar');
      return buscarPorCodigo(c, codigo);
    }

    // Modificación. Con el huésped ya hospedado solo cambian la salida y las personas.
    if (r.estado === 'en_curso' && (cuerpo.fecha_entrada !== undefined || cuerpo.habitacion_id !== undefined)) {
      throw new ErrorHttp(409, 'El huésped ya está hospedado: solo se puede cambiar la fecha de salida o la cantidad de personas.');
    }
    const nueva = {
      fecha_entrada: cuerpo.fecha_entrada !== undefined ? v.fecha(cuerpo.fecha_entrada, 'La fecha de entrada') : r.fecha_entrada,
      fecha_salida: cuerpo.fecha_salida !== undefined ? v.fecha(cuerpo.fecha_salida, 'La fecha de salida') : r.fecha_salida,
      personas: cuerpo.personas !== undefined ? v.entero(cuerpo.personas, 'La cantidad de personas', { min: 1, max: 8 }) : r.personas,
      habitacion_id: cuerpo.habitacion_id !== undefined ? v.entero(cuerpo.habitacion_id, 'La habitación', { min: 1, max: 32767 }) : r.habitacion_id,
    };
    if (r.estado === 'confirmada' && cuerpo.fecha_entrada !== undefined && nueva.fecha_entrada < hoy) {
      throw v.invalido('La fecha de entrada no puede estar en el pasado.');
    }
    if (r.estado === 'en_curso' && nueva.fecha_salida < hoy) {
      throw v.invalido('La fecha de salida no puede estar en el pasado.');
    }
    v.estancia(nueva.fecha_entrada, nueva.fecha_salida);
    const hab = await habitacionParaReservar(c, nueva.habitacion_id, nueva.personas);

    // Si cambian las fechas o la habitación, el total se recalcula con las tarifas vigentes.
    const cambiaPrecio = nueva.fecha_entrada !== r.fecha_entrada || nueva.fecha_salida !== r.fecha_salida
      || nueva.habitacion_id !== r.habitacion_id;
    const total = cambiaPrecio ? await calcularTotal(c, hab.tipo_id, nueva.fecha_entrada, nueva.fecha_salida) : r.tarifa_aplicada;

    const { rowCount } = await c.query(
      `UPDATE hotel.reservas
          SET fecha_entrada = $1, fecha_salida = $2, personas = $3, habitacion_id = $4, tarifa_aplicada = $5,
              version = version + 1, modificado_por = $6, modificado_en = now()
        WHERE id = $7 AND version = $8`,
      [nueva.fecha_entrada, nueva.fecha_salida, nueva.personas, nueva.habitacion_id, total, req.usuario.id, r.id, version],
    );
    if (!rowCount) exigirVersion({ version: -1 }, version);

    const antes = {};
    const despues = {};
    for (const campo of ['fecha_entrada', 'fecha_salida', 'personas', 'habitacion_id']) {
      if (nueva[campo] !== r[campo]) { antes[campo] = r[campo]; despues[campo] = nueva[campo]; }
    }
    if (cambiaPrecio) { antes.total = r.tarifa_aplicada; despues.total = String(total); }
    await registrarBitacora(c, r.id, req.usuario.id, 'modificar', { antes, despues });
    return buscarPorCodigo(c, codigo);
  });

  res.json(vistaReserva(actualizada));
});

// POST /api/reservas/:codigo/checkin  (RF06; el documento se registra aquí)
router.post('/reservas/:codigo/checkin', interno, async (req, res) => {
  const codigo = v.codigoReserva(req.params.codigo);
  const cuerpo = v.soloCampos(req.body, ['version', 'tipo_documento', 'numero_documento']);
  const version = v.entero(cuerpo.version, 'La versión', { min: 1, max: 2147483647 });
  const tipoDocumento = v.uno(cuerpo.tipo_documento, 'El tipo de documento', ['cedula', 'dimex', 'pasaporte']);
  const numeroDocumento = v.texto(cuerpo.numero_documento, 'El número de documento', { min: 5, max: 20 }).toUpperCase();
  if (!/^[A-Z0-9]+$/.test(numeroDocumento)) throw v.invalido('El número de documento solo admite letras y números, sin espacios ni guiones.');
  const hoy = v.hoyCostaRica();

  const actualizada = await enTransaccion(async (c) => {
    const r = await buscarPorCodigo(c, codigo);
    exigirVersion(r, version);
    if (r.estado !== 'confirmada') throw new ErrorHttp(409, 'Solo se registra la entrada de una reserva confirmada.');
    if (hoy < r.fecha_entrada || hoy >= r.fecha_salida) {
      throw new ErrorHttp(409, 'Hoy no está dentro de las fechas de la reserva. Modifique la reserva primero.');
    }
    await c.query(
      'UPDATE hotel.huespedes SET tipo_documento = $1, numero_documento = $2 WHERE id = $3',
      [tipoDocumento, numeroDocumento, r.huesped_id],
    );
    const { rowCount } = await c.query(
      `UPDATE hotel.reservas SET estado = 'en_curso', checkin_en = now(), version = version + 1,
              modificado_por = $1, modificado_en = now()
        WHERE id = $2 AND version = $3`,
      [req.usuario.id, r.id, version],
    );
    if (!rowCount) exigirVersion({ version: -1 }, version);
    // La bitácora no guarda el número de documento: no hace falta para la trazabilidad.
    await registrarBitacora(c, r.id, req.usuario.id, 'checkin');
    return buscarPorCodigo(c, codigo);
  });
  res.json(vistaReserva(actualizada));
});

// POST /api/reservas/:codigo/checkout  (RF06)
router.post('/reservas/:codigo/checkout', interno, async (req, res) => {
  const codigo = v.codigoReserva(req.params.codigo);
  const cuerpo = v.soloCampos(req.body, ['version']);
  const version = v.entero(cuerpo.version, 'La versión', { min: 1, max: 2147483647 });

  const actualizada = await enTransaccion(async (c) => {
    const r = await buscarPorCodigo(c, codigo);
    exigirVersion(r, version);
    if (r.estado !== 'en_curso') throw new ErrorHttp(409, 'Solo se registra la salida de un huésped hospedado.');
    const { rowCount } = await c.query(
      `UPDATE hotel.reservas SET estado = 'finalizada', checkout_en = now(), version = version + 1,
              modificado_por = $1, modificado_en = now()
        WHERE id = $2 AND version = $3`,
      [req.usuario.id, r.id, version],
    );
    if (!rowCount) exigirVersion({ version: -1 }, version);
    await registrarBitacora(c, r.id, req.usuario.id, 'checkout');
    return buscarPorCodigo(c, codigo);
  });
  res.json(vistaReserva(actualizada));
});

// POST /api/reservas/:codigo/correo  (RF04: reenvío por recepción)
router.post('/reservas/:codigo/correo', interno, async (req, res) => {
  const { rows } = await consultar(`${SELECT_RESERVA} WHERE r.codigo = $1`, [v.codigoReserva(req.params.codigo)]);
  const r = rows[0];
  if (!r) throw new ErrorHttp(404, 'No existe una reserva con ese código.');
  if (r.estado === 'cancelada') throw new ErrorHttp(409, 'La reserva está cancelada.');
  if (!(await enviarYMarcar(r))) {
    throw new ErrorHttp(502, 'El servicio de correo no respondió. La reserva sigue válida; confirme por WhatsApp.');
  }
  res.json({ codigo: r.codigo, correo_enviado: true });
});

// GET /api/ocupacion/hoy  (RF11: llegadas, salidas y huéspedes hospedados)
router.get('/ocupacion/hoy', autenticar, permitir('ocupacion.consultar'), async (req, res) => {
  const { rows } = await consultar(
    `${SELECT_RESERVA}
      WHERE (r.fecha_entrada = ${HOY} AND r.estado IN ('confirmada', 'en_curso'))
         OR (r.fecha_salida = ${HOY} AND r.estado IN ('en_curso', 'finalizada'))
         OR r.estado = 'en_curso'
      ORDER BY h.numero`,
  );
  const hoy = v.hoyCostaRica();
  const pasoHoraSalida = v.horaCostaRica() >= HORA_SALIDA;
  const fila = (r) => ({
    codigo: r.codigo,
    habitacion: r.numero,
    huesped: r.nombre_completo,
    telefono: r.telefono,
    personas: r.personas,
    fecha_entrada: r.fecha_entrada,
    fecha_salida: r.fecha_salida,
    estado: r.estado,
    correo_pendiente: r.correo_pendiente,
  });
  const { rows: pendientes } = await consultar(
    "SELECT count(*)::int AS n FROM hotel.reservas WHERE correo_pendiente AND estado <> 'cancelada'",
  );
  res.json({
    fecha: hoy,
    hora_entrada: HORA_ENTRADA,
    hora_salida: HORA_SALIDA,
    llegadas: rows.filter((r) => r.fecha_entrada === hoy && ['confirmada', 'en_curso'].includes(r.estado)).map(fila),
    salidas: rows.filter((r) => r.fecha_salida === hoy).map(fila),
    hospedados: rows.filter((r) => r.estado === 'en_curso').map(fila),
    // Pasada la hora de salida, quien debía salir y no ha registrado su salida sigue en la habitación.
    siguen_despues_de_salida: pasoHoraSalida
      ? rows.filter((r) => r.estado === 'en_curso' && r.fecha_salida <= hoy).map(fila)
      : [],
    correos_pendientes: pendientes[0].n,
  });
});

module.exports = router;
