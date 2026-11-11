#!/bin/bash
# KUBEL — Instalador del lector de ONRED en el servidor kubel-onred (Ubuntu, como root).
# Uso (una sola línea en el servidor):
#   curl -fsSL https://raw.githubusercontent.com/kubelapp/kubelapp.github.io/<commit>/onred-lector/instalar.sh | bash -s <commit>
# Se puede repetir sin miedo: actualiza el programa y conserva las claves (para cambiarlas: añadir «claves» al final).
# Desde el lector v3 no hace falta repetirlo para actualizar: el lector se actualiza solo cuando KUBEL lo pide.
set -euo pipefail
COMMIT="${1:-main}"
CAMBIAR_CLAVES="${2:-}"
RAW="https://raw.githubusercontent.com/kubelapp/kubelapp.github.io/$COMMIT/onred-lector"
ENVF=/etc/kubel-onred.env
DIR=/opt/kubel-onred

[ "$(id -u)" = 0 ] || { echo "Hay que ejecutarlo como root"; exit 1; }
echo "== KUBEL · lector de ONRED (versión $COMMIT) =="

# 1) Programa
mkdir -p "$DIR" /var/lib/kubel-onred
chmod 700 /var/lib/kubel-onred
curl -fsSL "$RAW/lector.py" -o "$DIR/lector.py.nuevo"
python3 -m py_compile "$DIR/lector.py.nuevo"
mv "$DIR/lector.py.nuevo" "$DIR/lector.py"
[ "$COMMIT" != "main" ] && echo "$COMMIT" > "$DIR/commit"
chmod 755 "$DIR/lector.py"
echo "✓ Programa en $DIR/lector.py"

# 2) Claves (solo en este servidor, archivo que solo lee root)
if [ ! -f "$ENVF" ] || [ "$CAMBIAR_CLAVES" = "claves" ]; then
  echo
  read -r -p "Usuario de ONRED (4 cifras): " U < /dev/tty
  read -r -s -p "Contraseña de ONRED (no se verá al escribir): " C < /dev/tty; echo
  S=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
  umask 077
  printf 'ONRED_USUARIO=%s\nONRED_CLAVE=%s\nKUBEL_SECRETO=%s\n' "$U" "$C" "$S" > "$ENVF"
  chmod 600 "$ENVF"
  unset U C
  echo "✓ Claves guardadas en $ENVF (solo root)"
else
  echo "✓ Claves ya guardadas en $ENVF (se conservan)"
fi

# 3) Servicio y temporizador: cada 15 min de 07:00 a 20:45 (hora de Madrid)
cat > /etc/systemd/system/kubel-onred.service <<'UNIDAD'
[Unit]
Description=KUBEL - lector de ONRED
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/kubel-onred/lector.py
TimeoutStartSec=600
UNIDAD
cat > /etc/systemd/system/kubel-onred.timer <<'UNIDAD'
[Unit]
Description=KUBEL - lector de ONRED cada 15 minutos

[Timer]
OnCalendar=*-*-* 07..20:00/15:00 Europe/Madrid
RandomizedDelaySec=60
Persistent=false

[Install]
WantedBy=timers.target
UNIDAD
systemctl daemon-reload
systemctl enable --now kubel-onred.timer >/dev/null 2>&1
echo "✓ Temporizador en marcha (funcionará en cuanto KUBEL conozca la huella)"

# 4) Seguridad básica: cortafuegos (solo entra SSH) y actualizaciones automáticas
if ! command -v ufw >/dev/null; then apt-get -qq update && apt-get -qq install -y ufw >/dev/null; fi
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
echo "✓ Cortafuegos activo (solo SSH de entrada)"
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then apt-get -qq install -y unattended-upgrades >/dev/null; fi
echo "✓ Actualizaciones automáticas de seguridad"

# 5) Prueba de entrada en ONRED (no manda nada a KUBEL)
echo
echo "== Prueba de entrada en ONRED =="
python3 "$DIR/lector.py" --prueba || echo "⚠ La prueba ha fallado: copia el mensaje de arriba a Claude"

# 6) Huella del secreto para KUBEL (no es secreta: se puede pegar en el chat)
echo
echo "== Copia esta línea y pégasela a Claude =="
python3 -c 'import sys; sys.path.insert(0, "/opt/kubel-onred"); import lector, hashlib; print("HUELLA KUBEL:", hashlib.sha256(lector.config()["KUBEL_SECRETO"].encode()).hexdigest())'
