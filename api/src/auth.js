// Autenticación de usuarios internos (RF07, RNF01).
// La sesión es un JWT firmado que viaja en una cookie httpOnly, Secure y
// SameSite=Strict. La API no guarda sesiones en memoria (RNF08): cualquier
// réplica puede atender cualquier petición.

const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const { consultar } = require('./db');
const { ErrorHttp } = require('./errores');
const v = require('./validacion');

// Parámetros mínimos recomendados por OWASP para Argon2id: 19 MiB, 2 iteraciones, paralelismo 1.
const OPCIONES_ARGON2 = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const DURACION_SEGUNDOS = 8 * 60 * 60;   // un turno de trabajo
const COOKIE = 'sesion';
const OPCIONES_COOKIE = { httpOnly: true, secure: true, sameSite: 'strict', path: '/api' };
const SECRETO = process.env.JWT_SECRET;

// Hash de referencia para que un usuario inexistente tarde lo mismo que uno
// existente y no se pueda averiguar qué usuarios hay midiendo el tiempo.
const hashReferencia = argon2.hash('referencia-sin-uso', OPCIONES_ARGON2);

function generarHash(contrasena) {
  return argon2.hash(contrasena, OPCIONES_ARGON2);
}

function leerCookie(req) {
  const encabezado = req.headers.cookie || '';
  for (const parte of encabezado.split(';')) {
    const [nombre, ...resto] = parte.trim().split('=');
    if (nombre === COOKIE) return resto.join('=');
  }
  return null;
}

// Verifica el token y vuelve a consultar al usuario: si fue desactivado o
// cambió de rol, el cambio aplica de inmediato.
async function usuarioDesdeToken(token) {
  let datos;
  try {
    datos = jwt.verify(token, SECRETO, { algorithms: ['HS256'] });
  } catch {
    throw new ErrorHttp(401, 'La sesión no es válida o venció. Inicie sesión de nuevo.');
  }
  const { rows } = await consultar(
    'SELECT id, nombre, usuario, rol, activo FROM hotel.usuarios WHERE id = $1',
    [Number(datos.sub)],
  );
  const u = rows[0];
  if (!u || !u.activo) throw new ErrorHttp(401, 'La sesión no es válida. Inicie sesión de nuevo.');
  return { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol };
}

// Middleware: exige sesión.
async function autenticar(req, res, next) {
  const token = leerCookie(req);
  if (!token) throw new ErrorHttp(401, 'Debe iniciar sesión.');
  req.usuario = await usuarioDesdeToken(token);
  next();
}

// Middleware: la sesión es opcional (crear reserva lo hace el huésped sin
// cuenta o recepción con sesión). Una cookie inválida sí se rechaza.
async function autenticarOpcional(req, res, next) {
  const token = leerCookie(req);
  if (token) req.usuario = await usuarioDesdeToken(token);
  next();
}

// POST /api/sesion
async function iniciarSesion(req, res) {
  const cuerpo = v.soloCampos(req.body, ['usuario', 'contrasena']);
  const usuario = v.texto(cuerpo.usuario, 'El usuario', { min: 3, max: 30 }).toLowerCase();
  const contrasena = v.texto(cuerpo.contrasena, 'La contraseña', { min: 1, max: 128 });

  const { rows } = await consultar(
    'SELECT id, nombre, rol, activo, hash_contrasena FROM hotel.usuarios WHERE usuario = $1',
    [usuario],
  );
  const u = rows[0];
  const valida = u && u.activo
    ? await argon2.verify(u.hash_contrasena, contrasena)
    : (await argon2.verify(await hashReferencia, contrasena), false);
  if (!valida) throw new ErrorHttp(401, 'Usuario o contraseña incorrectos.');

  const token = jwt.sign({ sub: String(u.id), rol: u.rol }, SECRETO, {
    algorithm: 'HS256',
    expiresIn: DURACION_SEGUNDOS,
  });
  res.cookie(COOKIE, token, { ...OPCIONES_COOKIE, maxAge: DURACION_SEGUNDOS * 1000 });
  res.json({ nombre: u.nombre, rol: u.rol });
}

// GET /api/sesion
function sesionActual(req, res) {
  res.json(req.usuario);
}

// DELETE /api/sesion
function cerrarSesion(req, res) {
  res.clearCookie(COOKIE, OPCIONES_COOKIE);
  res.status(204).end();
}

module.exports = {
  autenticar, autenticarOpcional, iniciarSesion, sesionActual, cerrarSesion, generarHash,
};
