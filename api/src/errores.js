// Errores de la API y su traducción a códigos HTTP.

class ErrorHttp extends Error {
  constructor(estado, mensaje) {
    super(mensaje);
    this.estado = estado;
  }
}

// Mensajes para las restricciones de la base que el usuario puede provocar.
const MENSAJES_RESTRICCION = {
  reservas_sin_traslape: 'La habitación ya está reservada en alguna de esas fechas.',
  temporadas_sin_traslape: 'La temporada se traslapa con otra existente.',
  usuarios_usuario_key: 'Ya existe un usuario con ese nombre de usuario.',
  habitaciones_numero_key: 'Ya existe una habitación con ese número.',
  tipos_habitacion_nombre_key: 'Ya existe un tipo de habitación con ese nombre.',
  huespedes_documento_unico: 'Ese documento ya está registrado para otro huésped.',
};

// Convierte un error de PostgreSQL en una respuesta comprensible, sin exponer detalles internos.
function traducirErrorBase(e) {
  switch (e.code) {
    case '23P01': // violación de una restricción de exclusión (traslape)
    case '23505': // valor duplicado
      return new ErrorHttp(409, MENSAJES_RESTRICCION[e.constraint] || 'El registro entra en conflicto con otro existente.');
    case '23503':
      return new ErrorHttp(400, 'Se hace referencia a un registro que no existe.');
    case '23514':
    case '23502':
      return new ErrorHttp(400, 'Los datos no cumplen las reglas del sistema.');
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
      return new ErrorHttp(400, 'Hay un dato con formato inválido.');
    case '57014':
      return new ErrorHttp(503, 'La base de datos tardó demasiado en responder.');
    default:
      break;
  }
  // Sin conexión con la base: el sistema entra en contingencia.
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', '57P01', '08006', '08001'].includes(e.code)
      || /timeout|terminated|Connection/i.test(e.message || '')) {
    return new ErrorHttp(503, 'Base de datos no disponible. Use el procedimiento de contingencia.');
  }
  return null;
}

// Manejador final de Express.
// eslint-disable-next-line no-unused-vars
function manejarErrores(err, req, res, next) {
  let error = err instanceof ErrorHttp ? err : null;
  if (!error && err.type === 'entity.parse.failed') error = new ErrorHttp(400, 'El cuerpo de la petición no es JSON válido.');
  if (!error && err.type === 'entity.too.large') error = new ErrorHttp(413, 'La petición es demasiado grande.');
  if (!error) error = traducirErrorBase(err);
  if (!error) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}:`, err.message);
    error = new ErrorHttp(500, 'Error interno.');
  }
  res.status(error.estado).json({ error: error.message });
}

module.exports = { ErrorHttp, manejarErrores };
