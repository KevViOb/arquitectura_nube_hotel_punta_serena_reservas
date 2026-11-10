# Tarea de respaldo diario (RF10): pg_dump con cron.
# Se usa la imagen de PostgreSQL 17 solo por sus herramientas cliente: pg_dump
# debe ser de la misma versión mayor que el servidor o más nueva.
FROM postgres:17.11-alpine3.24

RUN apk add --no-cache curl tzdata

COPY respaldo.sh entrypoint.sh /usr/local/bin/
COPY crontab /etc/crontabs/root
RUN chmod 0755 /usr/local/bin/respaldo.sh /usr/local/bin/entrypoint.sh \
 && chmod 0600 /etc/crontabs/root \
 && mkdir -p /respaldos

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
