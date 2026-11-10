#!/bin/sh
# cron no hereda las variables de entorno del contenedor. Este arranque las
# guarda en un archivo que solo root puede leer, y el script de respaldo lo carga.
set -eu
umask 077

: > /run/respaldo.env
for nombre in RESPALDO_DATABASE_URL SUPABASE_S3_ENDPOINT SUPABASE_S3_REGION \
              SUPABASE_S3_ACCESS_KEY_ID SUPABASE_S3_SECRET_ACCESS_KEY SUPABASE_BUCKET TZ; do
  eval "valor=\${$nombre:-}"
  # Comillas simples escapadas para que ningún carácter se interprete.
  escapado=$(printf '%s' "$valor" | sed "s/'/'\\\\''/g")
  printf "export %s='%s'\n" "$nombre" "$escapado" >> /run/respaldo.env
done

echo "Tarea de respaldo lista: se ejecuta todos los días a las 2:00 a. m. (hora de Costa Rica)."
exec crond -f -l 8
