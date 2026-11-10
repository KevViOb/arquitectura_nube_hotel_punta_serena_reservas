// Matriz de permisos por rol (RF07, RNF02).
// Administración hereda todo lo de recepción. Cada ruta protegida declara el
// permiso que exige y este middleware lo valida antes de ejecutar la operación.

const { ErrorHttp } = require('./errores');

const PERMISOS = {
  recepcion: [
    'reservas.gestionar',   // listar, crear, modificar, cancelar, check in, check out, reenviar correo
    'ocupacion.consultar',  // ocupación del día (RF11)
  ],
  administracion: [
    'reservas.gestionar',
    'ocupacion.consultar',
    'usuarios.administrar',   // RF07
    'catalogo.administrar',   // tipos, habitaciones, temporadas y tarifas (RF09)
    'reportes.consultar',     // RF08
  ],
};

// Se usa siempre después de autenticar.
function permitir(permiso) {
  return (req, res, next) => {
    const rol = req.usuario && req.usuario.rol;
    if (!rol) throw new ErrorHttp(401, 'Debe iniciar sesión.');
    if (!(PERMISOS[rol] || []).includes(permiso)) {
      throw new ErrorHttp(403, 'Su rol no tiene permiso para esta operación.');
    }
    next();
  };
}

module.exports = { PERMISOS, permitir };
