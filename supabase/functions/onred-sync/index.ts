// KUBEL — Robot de lectura del portal ONRED (CronosP «Gestión de Reparaciones», funcionareparaciones.es).
// v0 (07/11/2026): SOLO LECTURA. Entra con ONRED_USUARIO / ONRED_CLAVE, lee las listas
// «Pendiente de cita», «Citado pendiente de atención» y «En curso» y la ficha de cada servicio,
// y devuelve un resumen. No escribe nada en KUBEL ni pulsa nada en el portal.
// Lo llama pg_cron (más adelante) con la cabecera secreta x-kubel-secreto.
import postgres from 'npm:postgres@3.4.4';
import { DOMParser, Element } from 'https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts';

const BASE = 'https://www.funcionareparaciones.es/cronosp/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const CH = { 'sec-ch-ua': '"Chromium";v="157", "Google Chrome";v="157", "Not.A/Brand";v="99"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"', 'Upgrade-Insecure-Requests': '1', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1' };
const LISTAS = [
  { prog: 'cita', lista: 'pendiente_cita' },
  { prog: 'atencion', lista: 'citado' },
  { prog: 'encurso', lista: 'en_curso' },
] as const;

const limpio = (t?: string | null) => (t ?? '').replace(/ /g, ' ').replace(/[ \t\r]+/g, ' ').replace(/ *\n */g, '\n').trim();
const parse = (html: string) => {
  const d = new DOMParser().parseFromString(html, 'text/html');
  if (!d) throw new Error('No se pudo leer la página');
  return d;
};

class Sesion {
  cookies = new Map<string, string>();
  ultima = BASE + 'Login.aspx';
  private guardar(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  async pedir(ruta: string, form?: Record<string, string>): Promise<{ html: string; url: string }> {
    let url = ruta.startsWith('http') ? ruta : BASE + ruta;
    let method = form ? 'POST' : 'GET';
    let body: string | undefined = form ? new URLSearchParams(form).toString() : undefined;
    for (let i = 0; i < 8; i++) {
      const headers: Record<string, string> = {
        ...CH, 'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9',
        Referer: this.ultima,
      };
      if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers.Origin = 'https://www.funcionareparaciones.es'; }
      const res = await fetch(url, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(25000) });
      this.guardar(res);
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel();
        url = new URL(loc, url).href; method = 'GET'; body = undefined;
        continue;
      }
      const html = await res.text();
      this.ultima = url;
      if (/Mantenimiento\.htm/i.test(url)) throw new Error(`El portal dio error (página de mantenimiento) en ${ruta.split('?')[0]}`);
      if (!res.ok) throw new Error(`El portal respondió ${res.status} en ${ruta.split('?')[0]}`);
      return { html, url };
    }
    throw new Error('Demasiadas redirecciones');
  }
}

// Todos los campos del formulario ASP.NET (ocultos incluidos)
function camposFormulario(html: string) {
  const d = parse(html);
  const f: Record<string, string> = {};
  for (const n of d.querySelectorAll('input')) {
    const e = n as Element;
    const name = e.getAttribute('name');
    const type = (e.getAttribute('type') || 'text').toLowerCase();
    if (!name || ['submit', 'image', 'button', 'checkbox', 'radio'].includes(type)) continue;
    f[name] = e.getAttribute('value') ?? '';
  }
  return f;
}

const pideLogin = (html: string) => /Login1\$UserName/.test(html);
const captcha = (html: string) => /BotDetect|CaptchaCode|LBD_/i.test(html) && /captcha/i.test(html.replace(/BotDetectCaptcha\.ashx\?get=layout-stylesheet/g, ''));

async function entrar(s: Sesion, usuario: string, clave: string) {
  const { html } = await s.pedir('Login.aspx');
  const f = camposFormulario(html);
  f['__EVENTTARGET'] = '';
  f['__EVENTARGUMENT'] = '';
  if ('__SCROLLPOSITIONX' in f && !f['__SCROLLPOSITIONX']) f['__SCROLLPOSITIONX'] = '0';
  if ('__SCROLLPOSITIONY' in f && !f['__SCROLLPOSITIONY']) f['__SCROLLPOSITIONY'] = '0';
  f['ctl00$ContentPlaceHolder1$Login1$UserName'] = usuario;
  f['ctl00$ContentPlaceHolder1$Login1$Password'] = clave;
  f['ctl00$ContentPlaceHolder1$Login1$LoginButton'] = 'Inicia sesión';
  const r = await s.pedir('Login.aspx', f);
  const prof = (r.html.match(/Profesional:\s*(\d+)/) || [])[1];
  if (prof) return prof;
  if (pideLogin(r.html)) {
    const d = parse(r.html);
    const aviso = limpio(d.body?.textContent).match(/(usuario|clave|contraseña|bloquead|captcha)[^\n]{0,120}/i)?.[0];
    throw new Error('No se pudo entrar en ONRED' + (aviso ? `: ${aviso}` : '') + (captcha(r.html) ? ' (pide captcha)' : ''));
  }
  // A veces el login lleva a una página sin el número: probar la de inicio
  const ini = await s.pedir('Iniciador.aspx');
  const p2 = (ini.html.match(/Profesional:\s*(\d+)/) || [])[1];
  if (!p2) throw new Error('No se pudo entrar en ONRED (sin página de inicio)');
  return p2;
}

type Fila = { numero: string; lista: string; columnas: Record<string, string> };

function leerLista(html: string, lista: string): Fila[] {
  if (pideLogin(html)) throw new Error('Sesión caducada en la lista');
  const d = parse(html);
  const filas: Fila[] = [];
  for (const t of d.querySelectorAll('table[id^="ContentPlaceHolder1_GV"]')) {
    const tabla = t as Element;
    const trs = [...tabla.querySelectorAll('tr')] as Element[];
    if (!trs.length) continue;
    const cab = [...trs[0].querySelectorAll('th,td')].map((c) => limpio((c as Element).textContent));
    for (const tr of trs.slice(1)) {
      const celdas = [...tr.querySelectorAll('td')].map((c) => limpio((c as Element).textContent));
      const numero = celdas.find((c) => /^\d{6,8}$/.test(c));
      if (!numero) continue;
      const columnas: Record<string, string> = {};
      cab.forEach((k, i) => { if (k) columnas[k] = celdas[i] ?? ''; });
      filas.push({ numero, lista, columnas });
    }
  }
  return filas;
}

const CAMPOS_FICHA: Record<string, string> = {
  TxtNumservicio: 'numero', TxtSinCompania: 'siniestro_cia', TxtSiniFunciona: 'siniestro_onred', TxtProfesion: 'profesion',
  TxtUrg: 'urgente', TxtFeccita: 'cita', TxtTiposerv: 'tipo_servicio', TxtCobro: 'cobro', TxtDescAveria: 'descripcion',
  TxtProcedencia: 'procedencia', TxtPoliza: 'poliza', TxtNomcliente: 'cliente', TxtVip: 'vip', TextDNINIF: 'nif',
  TxtEmail: 'email', TxtDireccion: 'direccion', TxtNro: 'numero_via', TxtPiso: 'piso', TxtCPostal: 'cp',
  TxtPoblacion: 'poblacion', TxtProvincia: 'provincia', TxtObsDomCli: 'obs_domicilio',
};

function leerFicha(html: string) {
  if (pideLogin(html)) throw new Error('Sesión caducada en la ficha');
  const d = parse(html);
  const datos: Record<string, string> = {};
  const otros: Record<string, string> = {};
  for (const n of d.querySelectorAll('[id^="ContentPlaceHolder1_DatosCli_T"]')) {
    const e = n as Element;
    const id = e.getAttribute('id')!.replace('ContentPlaceHolder1_DatosCli_', '');
    const v = limpio(e.tagName === 'TEXTAREA' ? e.textContent : (e.getAttribute('value') ?? e.textContent));
    if (!v) continue;
    if (CAMPOS_FICHA[id]) datos[CAMPOS_FICHA[id]] = v; else otros[id] = v;
  }
  const tabla = (id: string) => {
    const t = d.getElementById(id);
    if (!t) return [] as Record<string, string>[];
    const trs = [...t.querySelectorAll('tr')] as Element[];
    const cab = [...(trs[0]?.querySelectorAll('th,td') ?? [])].map((c) => limpio((c as Element).textContent));
    return trs.slice(1).map((tr) => {
      const o: Record<string, string> = {};
      [...tr.querySelectorAll('td')].forEach((c, i) => { if (cab[i]) o[cab[i]] = limpio((c as Element).textContent); });
      return o;
    }).filter((o) => Object.values(o).some(Boolean));
  };
  return {
    datos, otros,
    comentarios: tabla('ContentPlaceHolder1_DatosCli_GVComentariosServ'),
    gremios: tabla('ContentPlaceHolder1_UCGestservicios_GVReparacion'),
  };
}

// Diagnóstico del login: UN solo intento, devuelve qué responde el portal en cada paso (sin la clave).
async function diagnostico(s: Sesion, usuario: string, clave: string, modo: string) {
  const pasos: unknown[] = [];
  const forma = (v: string) => ({ largo: v.length, espaciosFuera: v !== v.trim(), espaciosDentro: /\s/.test(v.trim()), soloCifras: /^\d+$/.test(v.trim()) });
  pasos.push({ paso: 'secretos', usuario: forma(usuario), clave: { largo: clave.length, espaciosFuera: clave !== clave.trim() } });
  usuario = usuario.trim(); clave = clave.trim();
  const headersBase = () => ({
    ...CH, 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9',
    ...(s.cookies.size ? { Cookie: [...s.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
  });
  const guardar = (res: Response) => { for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); if (i > 0) s.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } };
  const r1 = await fetch(BASE + 'Login.aspx', { headers: headersBase(), redirect: 'manual' });
  guardar(r1);
  const h1 = await r1.text();
  pasos.push({ paso: 'GET Login', status: r1.status, cookies: [...s.cookies.keys()], scriptManager: /ScriptManager1/.test(h1), campos: Object.keys(camposFormulario(h1)), captcha: /CaptchaCode|LBD_CaptchaDiv/i.test(h1) });
  const f = camposFormulario(h1);
  f['__EVENTTARGET'] = ''; f['__EVENTARGUMENT'] = ''; f['__LASTFOCUS'] = f['__LASTFOCUS'] ?? '';
  // El navegador rellena la posición de la página con «0» antes de enviar; vacía, ASP.NET puede fallar al leerla
  if ('__SCROLLPOSITIONX' in f && !f['__SCROLLPOSITIONX']) f['__SCROLLPOSITIONX'] = '0';
  if ('__SCROLLPOSITIONY' in f && !f['__SCROLLPOSITIONY']) f['__SCROLLPOSITIONY'] = '0';
  f['ctl00$ContentPlaceHolder1$Login1$UserName'] = usuario;
  f['ctl00$ContentPlaceHolder1$Login1$Password'] = clave;
  f['ctl00$ContentPlaceHolder1$Login1$LoginButton'] = 'Inicia sesión';
  const h: Record<string, string> = { ...headersBase(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Origin: 'https://www.funcionareparaciones.es', Referer: BASE + 'Login.aspx' };
  if (modo === 'ajax') {
    f['ctl00$ScriptManager1'] = 'ctl00$ContentPlaceHolder1$UpdatePanel1|ctl00$ContentPlaceHolder1$Login1$LoginButton';
    f['__ASYNCPOST'] = 'true';
    h['X-MicrosoftAjax'] = 'Delta=true'; h['X-Requested-With'] = 'XMLHttpRequest'; h['Accept'] = '*/*';
  }
  const r2 = await fetch(BASE + 'Login.aspx', { method: 'POST', headers: h, body: new URLSearchParams(f).toString(), redirect: 'manual' });
  guardar(r2);
  const h2 = await r2.text();
  pasos.push({ paso: 'POST Login', modo, status: r2.status, location: r2.headers.get('location'), cookies: [...s.cookies.keys()],
    profesional: (h2.match(/Profesional:\s*(\d+)/) || [])[1] ?? null, pideLogin: pideLogin(h2),
    texto: limpio(h2.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/[A-Za-z0-9+/=]{60,}/g, '…').slice(0, 700) });
  return { pasos };
}

let secreto: string | null = null;
async function leerSecreto() {
  if (secreto) return secreto;
  const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });
  try {
    const [f] = await sql`select valor from privado.ajustes where clave = 'notif_secreto'`;
    secreto = f?.valor ?? null;
  } finally { await sql.end(); }
  return secreto;
}

Deno.serve(async (req) => {
  const s = await leerSecreto();
  if (!s || req.headers.get('x-kubel-secreto') !== s) return new Response('no', { status: 401 });
  const inicio = Date.now();
  const usuarioBruto = Deno.env.get('ONRED_USUARIO');
  const claveBruta = Deno.env.get('ONRED_CLAVE');
  const usuario = usuarioBruto?.trim(), clave = claveBruta?.trim();
  const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
  if (!usuario || !clave) return json({ ok: false, error: 'Faltan ONRED_USUARIO / ONRED_CLAVE en los secretos' });
  const ses = new Sesion();
  if (new URL(req.url).searchParams.get('diag') === '1') return json(await diagnostico(ses, usuarioBruto!, claveBruta!, new URL(req.url).searchParams.get('modo') || 'normal'));
  try {
    const prof = await entrar(ses, usuario, clave);
    const filas: Fila[] = [];
    for (const l of LISTAS) {
      const { html } = await ses.pedir(`Iniciador.aspx?prog=${l.prog}`);
      filas.push(...leerLista(html, l.lista));
    }
    const fichas = [];
    for (const f of filas) {
      if (Date.now() - inicio > 100_000) break;
      try {
        const { html } = await ses.pedir(`Pantallas/Servicios/VerServicio.aspx?id=0_${f.numero}_${prof}`);
        fichas.push({ numero: f.numero, ...leerFicha(html) });
      } catch (err) { fichas.push({ numero: f.numero, error: (err as Error).message }); }
    }
    return json({ ok: true, profesional: prof, segundos: Math.round((Date.now() - inicio) / 1000), filas, fichas });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message, segundos: Math.round((Date.now() - inicio) / 1000) });
  }
});
