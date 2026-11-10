#!/bin/sh
# Respaldo de la base del Hotel Punta Serena (RF10, RNF06).
#
# 1. pg_dump del esquema hotel con el rol respaldo_hotel, de solo lectura.
# 2. Copia comprimida en el volumen local; se conservan las siete más recientes.
# 3. Copia externa en un bucket privado del almacenamiento de Supabase,
#    por su interfaz compatible con S3 y con una llave que solo sirve para el
#    almacenamiento. La copia externa se reemplaza cada día.
#
# Ejecución manual: docker compose exec respaldo respaldo.sh
set -eu

[ -f /run/respaldo.env ] && . /run/respaldo.env

DIRECTORIO=/respaldos
FECHA=$(date +%Y%m%d_%H%M)
SQL="$DIRECTORIO/hotel_$FECHA.sql"
ARCHIVO="$SQL.gz"

registrar() { echo "$(date '+%Y-%m-%d %H:%M:%S') respaldo: $*"; }

# Si algo falla a medias, no quedan archivos parciales.
trap 'rm -f "$SQL.parcial" "$SQL.parcial.gz"' EXIT

registrar "inicio"

# Si pg_dump falla, set -e detiene el script y no se toca ninguna copia anterior.
pg_dump --dbname="$RESPALDO_DATABASE_URL" --schema=hotel --no-owner --file="$SQL.parcial"
gzip -9 "$SQL.parcial"
gzip -t "$SQL.parcial.gz"
mv "$SQL.parcial.gz" "$ARCHIVO"
registrar "copia local creada: $(basename "$ARCHIVO") ($(du -h "$ARCHIVO" | cut -f1))"

# Retención: solo las siete copias más recientes.
ls -1t "$DIRECTORIO"/hotel_*.sql.gz | tail -n +8 | xargs -r rm -f
registrar "copias locales conservadas: $(ls -1 "$DIRECTORIO"/hotel_*.sql.gz | wc -l)"

# Copia externa. Si falla, la copia local ya existe y el error queda en el registro.
if curl --fail --silent --show-error --max-time 120 \
     --aws-sigv4 "aws:amz:${SUPABASE_S3_REGION}:s3" \
     --user "${SUPABASE_S3_ACCESS_KEY_ID}:${SUPABASE_S3_SECRET_ACCESS_KEY}" \
     -H "Content-Type: application/gzip" \
     --upload-file "$ARCHIVO" \
     "${SUPABASE_S3_ENDPOINT%/}/${SUPABASE_BUCKET}/hotel_ultimo.sql.gz"; then
  registrar "copia externa actualizada en el bucket ${SUPABASE_BUCKET}"
else
  registrar "ERROR: no se pudo subir la copia externa; la copia local sí quedó"
  exit 1
fi

registrar "fin"
