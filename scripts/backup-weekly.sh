#!/usr/bin/env bash
# ============================================================
# backup-weekly.sh — Backup semanal de la base de datos Supabase
# ============================================================
#
# Qué hace:
#   Exporta todas las tablas de tu BD Supabase a un archivo .sql
#   comprimido con fecha. Mantiene los últimos 12 backups (3 meses).
#
# Requisitos:
#   - postgresql-client instalado (pg_dump)
#     Ubuntu/WSL: sudo apt install postgresql-client
#     Mac:         brew install postgresql
#     Windows:     https://www.postgresql.org/download/windows/
#
# Instalación:
#   1. Copia este archivo a una carpeta segura, ej: ~/backups-citasmed/
#   2. Dale permisos: chmod +x backup-weekly.sh
#   3. Obtén la cadena de conexión "Postgres connection string"
#      en Supabase → Project Settings → Database → Connection string
#      URI. Tendrá este formato:
#      postgresql://postgres.xxxx:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres
#   4. Edita la variable DATABASE_URL abajo con esa cadena.
#   5. Ejecuta manualmente la primera vez para probar:
#      ./backup-weekly.sh
#   6. Programa con cron para que corra cada lunes 3 AM:
#      crontab -e
#      Añade la línea:
#      0 3 * * 1 /ruta/completa/backup-weekly.sh >> /ruta/completa/backup.log 2>&1
#
# Si estás en Windows sin WSL, usa Task Scheduler con:
#      pg_dump "$DATABASE_URL" -F c -f backup-$fecha.dump

set -euo pipefail

# ============================================================
# CONFIGURACIÓN — EDITA ESTOS VALORES
# ============================================================

# Pega aquí tu connection string de Supabase
DATABASE_URL="postgresql://postgres.TU_PROJECT:TU_PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres"

# Carpeta donde guardar los backups
BACKUP_DIR="$HOME/backups-citasmed"

# Cuántos backups conservar (uno por semana → 12 = 3 meses)
KEEP_LAST=12

# ============================================================
# SCRIPT (no necesitas editar desde aquí)
# ============================================================

FECHA=$(date +%Y-%m-%d_%H%M)
ARCHIVO="$BACKUP_DIR/citasmed-$FECHA.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[$(date)] Iniciando backup..."
echo "  → Destino: $ARCHIVO"

# Dump: solo esquema + datos, sin owner/privilegios (portable)
pg_dump "$DATABASE_URL" \
  --no-owner \
  --no-privileges \
  --schema=public \
  --format=plain \
  | gzip -9 > "$ARCHIVO"

TAMANO=$(du -h "$ARCHIVO" | cut -f1)
echo "[$(date)] ✓ Backup creado: $TAMANO"

# Limpieza: borrar backups viejos, conservar los últimos N
cd "$BACKUP_DIR"
ls -1t citasmed-*.sql.gz 2>/dev/null | tail -n +$((KEEP_LAST + 1)) | xargs -r rm --

CONSERVADOS=$(ls -1 citasmed-*.sql.gz 2>/dev/null | wc -l)
echo "[$(date)] Backups conservados: $CONSERVADOS"
echo "[$(date)] Listo."

# ============================================================
# CÓMO RESTAURAR UN BACKUP (solo para referencia)
# ============================================================
# Si necesitas restaurar el último backup a la base de datos:
#
#   gunzip -c citasmed-2026-04-21_0300.sql.gz | psql "$DATABASE_URL"
#
# Advertencia: esto sobrescribirá datos actuales. Antes de ejecutar,
# haz un backup nuevo y prueba en una base de datos de staging.
# ============================================================
