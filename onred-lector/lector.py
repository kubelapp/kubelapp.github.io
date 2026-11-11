#!/usr/bin/env python3
"""KUBEL — Lector de ONRED (v2, 11/11/2026). Vive en el servidor kubel-onred (Clouding.io, Barcelona).

ONRED solo admite conexiones desde España, así que este programa entra en el portal, descarga las listas
y las fichas de los servicios y se las manda a KUBEL (Edge Function onred-recibir), que es quien las lee y
las guarda. SOLO LECTURA: nunca pulsa nada en el portal.

Configuración en /etc/kubel-onred.env (solo root; la lee este programa): ONRED_USUARIO, ONRED_CLAVE, KUBEL_SECRETO [, KUBEL_URL].
Uso:  lector.py            una pasada completa (lo lanza el temporizador kubel-onred.timer)
      lector.py --prueba   solo entra y cuenta los servicios de cada lista (no manda nada a KUBEL)
Sin paquetes extra: solo Python 3.
"""
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = 'lector-2'  # v2: si una ficha pide entrar (sesión de ONRED a medias), entra de nuevo y la repite
BASE = os.environ.get('ONRED_BASE', 'https://www.funcionareparaciones.es/cronosp/')  # ONRED_BASE: solo pruebas
KUBEL_URL_DEF = 'https://hytmotuhdxbzpustnlzx.supabase.co/functions/v1/onred-recibir'
COOKIES = os.environ.get('ONRED_COOKIES', '/var/lib/kubel-onred/cookies.txt')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/157.0.0.0 Safari/537.36')
LISTAS = [('cita', 'pendiente_cita'), ('atencion', 'citado'), ('encurso', 'en_curso')]
TANDA = 8          # fichas por envío a KUBEL
TOPE = 8 * 60      # segundos máximos por pasada
PAUSA = float(os.environ.get("ONRED_PAUSA", "1.0"))        # segundos entre páginas (no cargar el portal)


ENVF = '/etc/kubel-onred.env'


def config():
    """Lee /etc/kubel-onred.env tal cual (CLAVE=valor por línea; la contraseña puede llevar cualquier signo)."""
    c = {}
    try:
        with open(ENVF, encoding='utf-8') as f:
            for linea in f:
                linea = linea.rstrip('\r\n')
                if '=' in linea and not linea.startswith('#'):
                    k, v = linea.split('=', 1)
                    c[k.strip()] = v
    except FileNotFoundError:
        pass
    for k in ('ONRED_USUARIO', 'ONRED_CLAVE', 'KUBEL_SECRETO', 'KUBEL_URL'):
        if os.environ.get(k):
            c[k] = os.environ[k]
    return c


CFG = {}


class Fallo(Exception):
    pass


class Portal:
    def __init__(self):
        os.makedirs(os.path.dirname(COOKIES), mode=0o700, exist_ok=True)
        self.jar = http.cookiejar.LWPCookieJar(COOKIES)
        try:
            self.jar.load(ignore_discard=True, ignore_expires=True)
        except (FileNotFoundError, http.cookiejar.LoadError):
            pass
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.ultima = BASE + 'Login.aspx'

    def guardar(self):
        self.jar.save(ignore_discard=True, ignore_expires=True)
        os.chmod(COOKIES, 0o600)

    def pedir(self, ruta, form=None):
        url = ruta if ruta.startswith('http') else BASE + ruta
        datos = urllib.parse.urlencode(form).encode() if form is not None else None
        req = urllib.request.Request(url, data=datos, headers={
            'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-ES,es;q=0.9', 'Referer': self.ultima})
        if datos:
            req.add_header('Content-Type', 'application/x-www-form-urlencoded')
            req.add_header('Origin', 'https://www.funcionareparaciones.es')
        try:
            with self.op.open(req, timeout=30) as r:
                html = r.read().decode(r.headers.get_content_charset() or 'utf-8', 'replace')
                final = r.geturl()
        except urllib.error.HTTPError as e:
            if 'Mantenimiento' in (e.geturl() or ''):
                raise Fallo('El portal dio error (página de mantenimiento) en ' + ruta.split('?')[0])
            raise Fallo(f'El portal respondió {e.code} en ' + ruta.split('?')[0])
        if re.search(r'Mantenimiento\.htm', final, re.I):
            raise Fallo('El portal dio error (página de mantenimiento) en ' + ruta.split('?')[0])
        self.ultima = final
        time.sleep(PAUSA)
        return html


def pide_login(html):
    return 'Login1$UserName' in html


def campos(html):
    """Todos los <input> del formulario salvo botones y casillas (como el navegador)."""
    f = {}
    for m in re.finditer(r'<input\b[^>]*>', html, re.I):
        t = m.group(0)
        nombre = re.search(r'\bname="([^"]*)"', t)
        if not nombre:
            continue
        tipo = (re.search(r'\btype="([^"]*)"', t) or [None, 'text'])[1].lower()
        if tipo in ('submit', 'image', 'button', 'checkbox', 'radio'):
            continue
        valor = re.search(r'\bvalue="([^"]*)"', t)
        f[nombre.group(1)] = (valor.group(1) if valor else '').replace('&amp;', '&').replace('&quot;', '"') \
            .replace('&lt;', '<').replace('&gt;', '>').replace('&#39;', "'")
    return f


def entrar(p, usuario, clave):
    html = p.pedir('Login.aspx')
    f = campos(html)
    f['__EVENTTARGET'] = ''
    f['__EVENTARGUMENT'] = ''
    f['ctl00$ContentPlaceHolder1$Login1$UserName'] = usuario
    f['ctl00$ContentPlaceHolder1$Login1$Password'] = clave
    f['ctl00$ContentPlaceHolder1$Login1$LoginButton'] = 'Inicia sesión'
    html = p.pedir('Login.aspx', f)
    m = re.search(r'Profesional:\s*(\d+)', html)
    if m:
        return m.group(1)
    if pide_login(html):
        aviso = 'captcha' if re.search(r'CaptchaCode|LBD_CaptchaDiv', html, re.I) else 'usuario o clave, o bloqueo'
        raise Fallo('No se pudo entrar en ONRED (' + aviso + ')')
    m = re.search(r'Profesional:\s*(\d+)', p.pedir('Iniciador.aspx'))
    if not m:
        raise Fallo('No se pudo entrar en ONRED (sin página de inicio)')
    return m.group(1)


def ligero(html):
    """Quita lo que KUBEL no necesita (estado ASP.NET y scripts) para mandar menos datos."""
    html = re.sub(r'<input[^>]*name="__(VIEWSTATE|EVENTVALIDATION)[^"]*"[^>]*>', '', html, flags=re.I)
    return re.sub(r'<script\b[\s\S]*?</script>', '', html, flags=re.I)


def a_kubel(cuerpo):
    datos = json.dumps(cuerpo).encode()
    req = urllib.request.Request(CFG.get('KUBEL_URL') or KUBEL_URL_DEF, data=datos, headers={
        'Content-Type': 'application/json', 'x-onred-lector': CFG['KUBEL_SECRETO']})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise Fallo(f'KUBEL respondió {e.code}' + (' (secreto del lector no reconocido)' if e.code == 401 else ''))


def main():
    prueba = '--prueba' in sys.argv
    CFG.update(config())
    usuario = CFG.get('ONRED_USUARIO', '').strip()
    clave = CFG.get('ONRED_CLAVE', '').strip()
    if not usuario or not clave or (not prueba and not CFG.get('KUBEL_SECRETO')):
        print('Falta ONRED_USUARIO / ONRED_CLAVE / KUBEL_SECRETO en /etc/kubel-onred.env')
        return 2
    inicio = time.time()
    seg = lambda: round(time.time() - inicio, 1)
    p = Portal()
    prof = None
    try:
        # Se reutiliza la sesión guardada; solo se entra con usuario y clave si ha caducado
        listas = {}
        for prog, nombre in LISTAS:
            html = p.pedir(f'Iniciador.aspx?prog={prog}')
            if pide_login(html):
                prof = entrar(p, usuario, clave)
                print('Entrada en ONRED, profesional', prof)
                html = p.pedir(f'Iniciador.aspx?prog={prog}')
                if pide_login(html):
                    raise Fallo('ONRED vuelve a pedir el login tras entrar')
            if not prof:
                m = re.search(r'Profesional:\s*(\d+)', html)
                prof = m.group(1) if m else None
            listas[nombre] = ligero(html)
        if not prof:  # la sesión guardada no dejó ver el nº de profesional: entrar de nuevo
            prof = entrar(p, usuario, clave)
        p.guardar()
        if prueba:
            for nombre, html in listas.items():
                nums = sorted(set(re.findall(r'>\s*(\d{7})\s*<', html)))
                print(f'{nombre}: {len(nums)} servicio(s) {" ".join(nums)}')
            print(f'HA ENTRADO (profesional {prof}) en {seg()} s. Prueba: no se ha mandado nada a KUBEL.')
            return 0

        r = a_kubel({'lector': VERSION, 'ronda': 1, 'profesional': prof, 'segundos': seg(), 'listas': listas})
        if not r.get('ok'):
            print('KUBEL no aceptó las listas:', r.get('error'))
            return 1
        pedir = r.get('pedir') or []
        print(f"Listas enviadas: {r.get('nuevos')} nuevo(s), {r.get('desaparecidos')} desaparecido(s); "
              f'{len(pedir)} ficha(s) pedidas')
        tanda, enviadas = {}, 0
        for n in pedir:
            if time.time() - inicio > TOPE:
                print('Tope de tiempo: quedan fichas para la próxima pasada')
                break
            try:
                html = p.pedir(f'Pantallas/Servicios/VerServicio.aspx?id=0_{n}_{prof}')
                if pide_login(html):
                    # La sesión guardada vale para las listas pero no para las fichas: entrar y repetir
                    prof = entrar(p, usuario, clave)
                    print('Sesión de ONRED renovada para las fichas')
                    html = p.pedir(f'Pantallas/Servicios/VerServicio.aspx?id=0_{n}_{prof}')
                tanda[n] = ligero(html)
            except Fallo as e:
                tanda[n] = {'error': str(e)}
            if len(tanda) >= TANDA:
                enviadas += a_kubel({'lector': VERSION, 'ronda': 2, 'lectura': r.get('lectura'),
                                     'segundos': seg(), 'fichas': tanda}).get('fichas', 0)
                tanda = {}
        if tanda:
            enviadas += a_kubel({'lector': VERSION, 'ronda': 2, 'lectura': r.get('lectura'),
                                 'segundos': seg(), 'fichas': tanda}).get('fichas', 0)
        p.guardar()
        print(f'Fichas guardadas en KUBEL: {enviadas}. Pasada terminada en {seg()} s.')
        return 0
    except Exception as e:  # noqa: BLE001 — cualquier fallo se apunta en KUBEL
        msg = str(e) if isinstance(e, Fallo) else f'{type(e).__name__}: {e}'
        print('ERROR:', msg)
        if not prueba and CFG.get('KUBEL_SECRETO'):
            try:
                a_kubel({'lector': VERSION, 'profesional': prof, 'segundos': seg(), 'error': msg})
            except Exception as e2:  # noqa: BLE001
                print('Tampoco se pudo avisar a KUBEL:', e2)
        return 1


if __name__ == '__main__':
    sys.exit(main())
