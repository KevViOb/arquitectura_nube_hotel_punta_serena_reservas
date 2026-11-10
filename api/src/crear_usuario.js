// Crea un usuario interno con una contraseña aleatoria que se muestra una sola vez.
// Sirve para crear el primer usuario de administración; los demás se crean
// desde la API. Ninguna contraseña queda escrita en el repositorio.
//
// Uso:
//   docker compose run --rm api node src/crear_usuario.js <usuario> "<Nombre completo>" <recepcion|administracion>

const crypto = require('node:crypto');
const { generarHash } = require('./auth');
const { pool } = require('./db');

async function principal() {
  const [usuario, nombre, rol] = process.argv.slice(2);
  if (!usuario || !nombre || !['recepcion', 'administracion'].includes(rol) || !/^[a-z0-9._]{3,30}$/.test(usuario)) {
    console.error('Uso: node src/crear_usuario.js <usuario> "<Nombre completo>" <recepcion|administracion>');
    process.exit(1);
  }
  const contrasena = crypto.randomBytes(15).toString('base64url');   // 20 caracteres
  await pool.query(
    'INSERT INTO hotel.usuarios (nombre, usuario, hash_contrasena, rol) VALUES ($1, $2, $3, $4)',
    [nombre, usuario, await generarHash(contrasena), rol],
  );
  console.log(`Usuario ${usuario} creado con el rol ${rol}.`);
  console.log(`Contraseña temporal (se muestra una sola vez): ${contrasena}`);
  await pool.end();
}

principal().catch(async (e) => {
  console.error(e.code === '23505' ? 'Ese usuario ya existe.' : `No se pudo crear el usuario: ${e.message}`);
  await pool.end();
  process.exit(1);
});
