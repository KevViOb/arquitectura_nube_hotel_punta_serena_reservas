// Operaciones de administración: usuarios y roles (RF07), catálogo de
// habitaciones, temporadas y tarifas (RF09) y reporte de ocupación e ingresos (RF08).
// Nada se borra: los usuarios y las habitaciones se desactivan.

const express = require('express');
const { consultar } = require('./db');
const { ErrorHttp } = require('./errores');
const { autenticar, generarHash } = require('./auth');
const { permitir } = require('./roles');
const v = require('./validacion');

const router = express.Router();
const catalogo = [autenticar, permitir('catalogo.administrar')];
const usuarios = [autenticar, permitir('usuarios.administrar')];

function id(valor) {
  return v.entero(valor, 'El identificador', { min: 1, max: 32767 });
}

function exigirFila(rows, mensaje) {
  if (!rows[0]) throw new ErrorHttp(404, mensaje);
  return rows[0];
}

// Arma un UPDATE solo con los campos recibidos. Los nombres de columna vienen de
// una lista fija del código, nunca del navegador; los valores van parametrizados.
async function actualizar(tabla, idFila, campos, mensajeNoExiste) {
  const columnas = Object.keys(campos);
  if (!columnas.length) throw v.invalido('No se indicó ningún cambio.');
  const asignaciones = columnas.map((col, i) => `${col} = $${i + 1}`).join(', ');
  const { rows } = await consultar(
    `UPDATE hotel.${tabla} SET ${asignaciones} WHERE id = $${columnas.length + 1} RETURNING *`,
    [...Object.values(campos), idFila],
  );
  return exigirFila(rows, mensajeNoExiste);
}

// ---------------------------------------------------------------- Usuarios

function contrasenaNueva(valor) {
  return v.texto(valor, 'La contraseña', { min: 12, max: 128 });
}

function nombreUsuario(valor) {
  const u = v.texto(valor, 'El usuario', { min: 3, max: 30 }).toLowerCase();
  if (!/^[a-z0-9._]+$/.test(u)) throw v.invalido('El usuario solo admite letras minúsculas, números, punto y guion bajo.');
  return u;
}

const COLUMNAS_USUARIO = 'id, nombre, usuario, rol, activo, creado_en';

router.get('/usuarios', usuarios, async (req, res) => {
  const { rows } = await consultar(`SELECT ${COLUMNAS_USUARIO} FROM hotel.usuarios ORDER BY nombre`);
  res.json(rows);
});

router.post('/usuarios', usuarios, async (req, res) => {
  const c = v.soloCampos(req.body, ['nombre', 'usuario', 'contrasena', 'rol']);
  const datos = [
    v.texto(c.nombre, 'El nombre', { min: 3, max: 80 }),
    nombreUsuario(c.usuario),
    await generarHash(contrasenaNueva(c.contrasena)),
    v.uno(c.rol, 'El rol', ['recepcion', 'administracion']),
  ];
  const { rows } = await consultar(
    `INSERT INTO hotel.usuarios (nombre, usuario, hash_contrasena, rol) VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNAS_USUARIO}`,
    datos,
  );
  res.status(201).json(rows[0]);
});

router.patch('/usuarios/:id', usuarios, async (req, res) => {
  const idUsuario = id(req.params.id);
  const c = v.soloCampos(req.body, ['nombre', 'rol', 'activo', 'contrasena']);
  // Evita que la administración se bloquee a sí misma.
  if (idUsuario === req.usuario.id && (c.activo === false || (c.rol !== undefined && c.rol !== 'administracion'))) {
    throw new ErrorHttp(409, 'No puede desactivarse ni quitarse el rol de administración a sí mismo.');
  }
  const campos = {};
  if (c.nombre !== undefined) campos.nombre = v.texto(c.nombre, 'El nombre', { min: 3, max: 80 });
  if (c.rol !== undefined) campos.rol = v.uno(c.rol, 'El rol', ['recepcion', 'administracion']);
  if (c.activo !== undefined) campos.activo = v.booleano(c.activo, 'Activo');
  if (c.contrasena !== undefined) campos.hash_contrasena = await generarHash(contrasenaNueva(c.contrasena));
  const u = await actualizar('usuarios', idUsuario, campos, 'No existe ese usuario.');
  res.json({ id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, activo: u.activo, creado_en: u.creado_en });
});

// ---------------------------------------------------------------- Tipos de habitación

router.get('/tipos', catalogo, async (req, res) => {
  const { rows } = await consultar('SELECT * FROM hotel.tipos_habitacion ORDER BY id');
  res.json(rows);
});

router.post('/tipos', catalogo, async (req, res) => {
  const c = v.soloCampos(req.body, ['nombre', 'capacidad', 'descripcion']);
  const { rows } = await consultar(
    'INSERT INTO hotel.tipos_habitacion (nombre, capacidad, descripcion) VALUES ($1, $2, $3) RETURNING *',
    [
      v.texto(c.nombre, 'El nombre', { max: 40 }),
      v.entero(c.capacidad, 'La capacidad', { min: 1, max: 8 }),
      c.descripcion === undefined ? null : v.texto(c.descripcion, 'La descripción', { max: 200 }),
    ],
  );
  res.status(201).json(rows[0]);
});

router.patch('/tipos/:id', catalogo, async (req, res) => {
  const c = v.soloCampos(req.body, ['nombre', 'capacidad', 'descripcion']);
  const campos = {};
  if (c.nombre !== undefined) campos.nombre = v.texto(c.nombre, 'El nombre', { max: 40 });
  if (c.capacidad !== undefined) campos.capacidad = v.entero(c.capacidad, 'La capacidad', { min: 1, max: 8 });
  if (c.descripcion !== undefined) campos.descripcion = v.texto(c.descripcion, 'La descripción', { max: 200 });
  res.json(await actualizar('tipos_habitacion', id(req.params.id), campos, 'No existe ese tipo de habitación.'));
});

// ---------------------------------------------------------------- Habitaciones

router.get('/habitaciones', catalogo, async (req, res) => {
  const { rows } = await consultar(
    `SELECT h.id, h.numero, h.activa, h.tipo_id, th.nombre AS tipo, th.capacidad
       FROM hotel.habitaciones h JOIN hotel.tipos_habitacion th ON th.id = h.tipo_id
      ORDER BY h.numero`,
  );
  res.json(rows);
});

router.post('/habitaciones', catalogo, async (req, res) => {
  const c = v.soloCampos(req.body, ['numero', 'tipo_id']);
  const { rows } = await consultar(
    'INSERT INTO hotel.habitaciones (numero, tipo_id) VALUES ($1, $2) RETURNING *',
    [v.texto(c.numero, 'El número', { max: 10 }), id(c.tipo_id)],
  );
  res.status(201).json(rows[0]);
});

router.patch('/habitaciones/:id', catalogo, async (req, res) => {
  const c = v.soloCampos(req.body, ['tipo_id', 'activa']);
  const campos = {};
  if (c.tipo_id !== undefined) campos.tipo_id = id(c.tipo_id);
  if (c.activa !== undefined) campos.activa = v.booleano(c.activa, 'Activa');
  res.json(await actualizar('habitaciones', id(req.params.id), campos, 'No existe esa habitación.'));
});

// ---------------------------------------------------------------- Temporadas
// fecha_fin es el primer día que ya no pertenece a la temporada.

router.get('/temporadas', catalogo, async (req, res) => {
  const { rows } = await consultar('SELECT * FROM hotel.temporadas ORDER BY fecha_inicio');
  res.json(rows);
});

router.post('/temporadas', catalogo, async (req, res) => {
  const c = v.soloCampos(req.body, ['nombre', 'fecha_inicio', 'fecha_fin']);
  const { rows } = await consultar(
    'INSERT INTO hotel.temporadas (nombre, fecha_inicio, fecha_fin) VALUES ($1, $2, $3) RETURNING *',
    [
      v.texto(c.nombre, 'El nombre', { max: 40 }),
      v.fecha(c.fecha_inicio, 'La fecha de inicio'),
      v.fecha(c.fecha_fin, 'La fecha de fin'),
    ],
  );
  res.status(201).json(rows[0]);
});

router.patch('/temporadas/:id', catalogo, async (req, res) => {
  const c = v.soloCampos(req.body, ['nombre', 'fecha_inicio', 'fecha_fin']);
  const campos = {};
  if (c.nombre !== undefined) campos.nombre = v.texto(c.nombre, 'El nombre', { max: 40 });
  if (c.fecha_inicio !== undefined) campos.fecha_inicio = v.fecha(c.fecha_inicio, 'La fecha de inicio');
  if (c.fecha_fin !== undefined) campos.fecha_fin = v.fecha(c.fecha_fin, 'La fecha de fin');
  res.json(await actualizar('temporadas', id(req.params.id), campos, 'No existe esa temporada.'));
});

// ---------------------------------------------------------------- Tarifas
// Cambiar una tarifa no altera las reservas ya hechas: cada una guarda su total pactado.

router.get('/tarifas', catalogo, async (req, res) => {
  const { rows } = await consultar(
    `SELECT t.tipo_id, th.nombre AS tipo, t.temporada_id, s.nombre AS temporada,
            s.fecha_inicio, s.fecha_fin, t.precio_noche
       FROM hotel.tarifas t
       JOIN hotel.tipos_habitacion th ON th.id = t.tipo_id
       JOIN hotel.temporadas s ON s.id = t.temporada_id
      ORDER BY s.fecha_inicio, th.nombre`,
  );
  res.json(rows);
});

// PUT /api/tarifas: crea o reemplaza el precio de un tipo en una temporada.
router.put('/tarifas', catalogo, async (req, res) => {
  const c = v.soloCampos(req.body, ['tipo_id', 'temporada_id', 'precio_noche']);
  const { rows } = await consultar(
    `INSERT INTO hotel.tarifas (tipo_id, temporada_id, precio_noche) VALUES ($1, $2, $3)
     ON CONFLICT (tipo_id, temporada_id) DO UPDATE SET precio_noche = EXCLUDED.precio_noche
     RETURNING *`,
    [id(c.tipo_id), id(c.temporada_id), v.precio(c.precio_noche, 'El precio por noche')],
  );
  res.json(rows[0]);
});

// ---------------------------------------------------------------- Reporte (RF08)
// GET /api/reportes/ocupacion?desde=AAAA-MM-DD&hasta=AAAA-MM-DD  (ambas fechas incluidas)

router.get('/reportes/ocupacion', autenticar, permitir('reportes.consultar'), async (req, res) => {
  const desde = v.fecha(req.query.desde, 'La fecha desde');
  const hasta = v.fecha(req.query.hasta, 'La fecha hasta');
  if (hasta < desde || v.diasEntre(desde, hasta) > 365) throw v.invalido('El periodo no es válido (máximo un año).');
  const finExclusivo = v.sumarDias(hasta, 1);

  const { rows } = await consultar(
    `WITH dias AS (
       SELECT d::date AS dia FROM generate_series($1::date, $2::date - 1, interval '1 day') AS d
     )
     SELECT
       (SELECT count(*) FROM dias)::int AS dias,
       (SELECT count(*) FROM hotel.habitaciones WHERE activa)::int AS habitaciones_activas,
       (SELECT count(*) FROM hotel.reservas r JOIN dias ON dias.dia >= r.fecha_entrada AND dias.dia < r.fecha_salida
         WHERE r.estado <> 'cancelada')::int AS noches_vendidas,
       (SELECT count(*) FROM hotel.reservas
         WHERE estado <> 'cancelada' AND fecha_entrada >= $1 AND fecha_entrada < $2)::int AS reservas,
       (SELECT coalesce(sum(tarifa_aplicada), 0) FROM hotel.reservas
         WHERE estado <> 'cancelada' AND fecha_entrada >= $1 AND fecha_entrada < $2) AS ingresos,
       (SELECT count(*) FROM hotel.reservas
         WHERE estado = 'cancelada' AND fecha_entrada >= $1 AND fecha_entrada < $2)::int AS canceladas`,
    [desde, finExclusivo],
  );
  const r = rows[0];
  const disponibles = r.dias * r.habitaciones_activas;
  res.json({
    desde,
    hasta,
    noches_disponibles: disponibles,
    noches_vendidas: r.noches_vendidas,
    ocupacion_porcentaje: disponibles ? Math.round((r.noches_vendidas / disponibles) * 1000) / 10 : 0,
    reservas: r.reservas,
    canceladas: r.canceladas,
    ingresos: r.ingresos,
    moneda: 'USD',
    criterio: 'La ocupación cuenta las noches de reservas no canceladas dentro del periodo frente a las '
      + 'habitaciones activas hoy. Los ingresos suman el total pactado de las reservas no canceladas '
      + 'cuya fecha de entrada cae en el periodo.',
  });
});

module.exports = router;
