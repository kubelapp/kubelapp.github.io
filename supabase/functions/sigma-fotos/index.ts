// KUBEL — Robot sigma-fotos (v7, 07/11/2026). v7: paso 2 · Confirmación: «Leer de SIGMA» (partes.sigma_confir_pedir, SQL 36)
// lee la Confirmación (variante, clasificador de daños hecho o no, formulario que rellena el portal); ?leerconfir=N&cuenta= = diagnóstico.
// v6 (06/11/2026). v6: ?importar=1 TRAE A KUBEL las fotos que ya hay en el portal
// (SQL 35, tabla fotos_portal; Storage portal/<parte>/<codigo>.jpg): lee la pestaña Fotografías de cada servicio
// (nunca leídos primero; abiertos cada 12 h; «↻ Traer de SIGMA» de la oficina antes que nada) y descarga cada foto
// con su enlace pdf.php, de una en una y con tope de tiempo. Solo lectura en el portal. ?verfoto=N&cuenta= = diagnóstico.
// v5: Sube a SIGMA las fotos y los DOCUMENTOS (SQL 33: albarán con
// «Adjuntar albarán», el resto con «Nuevo Documento» y su tipo) que la oficina envía desde la
// pestaña «Pasos SIGMA» de la ficha del servicio (SQL 32).
// fotos.sigma_estado: null sin enviar · aprobado en cola · enviando · enviado · error · omitido.
// Cada foto se añade en la pestaña «Fotografías» del servicio en el portal (fotservicio.php):
//   1) Parte afectada = Asegurado → «Continuar» (solo muestra el segundo paso, no guarda nada)
//   2) fecha de la foto, Momento (Antes/Después), comentario y archivo JPEG → «Añadir Fotografía»
//   3) se vuelve a abrir la pestaña y solo se da por subida si aparece una foto nueva.
// Nunca se repite una subida a ciegas: si el portal no contesta, se mira otra vez antes de decidir.
// Las fotos se reservan DE UNA EN UNA y con tope de tiempo (las Edge Functions se cortan a los 150 s):
// lo que no cabe sigue en cola y lo recoge el cron kubel-sigma-fotos (cada 2 min, solo si hay algo).
// Además guarda en partes.sigma_fotos lo que hay en el portal { total, antes, despues } tras subir, o
// cuando la oficina pulsa «↻ Comprobar en SIGMA» (partes.sigma_fotos_pedir).
// Diagnóstico de solo lectura: ?ver=N&cuenta=VLL → fotos que tiene el servicio en el portal.
// Lo llaman la RPC aprobar_fotos_sigma / comprobar_fotos_sigma y pg_cron. Cabecera secreta x-kubel-secreto.
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import postgres from 'npm:postgres@3.4.4';

const BASE = 'https://web.multiasistencia.com/w3multi/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const CUENTAS: Record<string, string> = { VLL: 'Valladolid', PAL: 'Palencia' };
const MAX_BYTES = 6291456; // límite del portal (6 MB)
const TOPE_MS = 95000;     // no empezar una foto nueva pasado este tiempo
const MOMENTO: Record<string, { cod: string; texto: string }> = {
  antes: { cod: 'A', texto: 'Antes' }, despues: { cod: 'D', texto: 'Despues' },
};
const dec = new TextDecoder('windows-1252');
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const limpio = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// Texto a bytes windows-1252 (el portal no es UTF-8)
const W1252: Record<number, number> = { 0x20AC: 0x80, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2013: 0x96, 0x2014: 0x97 };
function bytes1252(s: string) {
  const out: number[] = [];
  for (const ch of s) { const c = ch.codePointAt(0)!; out.push(c < 0x100 ? c : (W1252[c] ?? 0x3F)); }
  return new Uint8Array(out);
}
// Cuerpo multipart hecho a mano para controlar la codificación de los campos
function multipart(campos: [string, string][], archivo?: { campo: string; nombre: string; datos: Uint8Array; tipo?: string }) {
  const limite = '----KubelFotos' + crypto.randomUUID().replace(/-/g, '');
  const partes: Uint8Array[] = [];
  for (const [k, v] of campos) partes.push(bytes1252(`--${limite}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (archivo) {
    partes.push(bytes1252(`--${limite}\r\nContent-Disposition: form-data; name="${archivo.campo}"; filename="${archivo.nombre}"\r\nContent-Type: ${archivo.tipo || 'image/jpeg'}\r\n\r\n`));
    partes.push(archivo.datos, bytes1252('\r\n'));
  }
  partes.push(bytes1252(`--${limite}--\r\n`));
  const total = partes.reduce((a, p) => a + p.length, 0);
  const cuerpo = new Uint8Array(total); let o = 0;
  for (const p of partes) { cuerpo.set(p, o); o += p.length; }
  return { cuerpo, tipo: `multipart/form-data; boundary=${limite}` };
}

class Sesion {
  cookies = new Map<string, string>();
  async pedir(ruta: string, opc: { form?: Record<string, string>; multi?: { cuerpo: Uint8Array; tipo: string }; timeout?: number } = {}): Promise<string> {
    let url = BASE + ruta;
    let method = opc.form || opc.multi ? 'POST' : 'GET';
    let body: string | Uint8Array | undefined = opc.multi ? opc.multi.cuerpo : opc.form ? new URLSearchParams(opc.form).toString() : undefined;
    let tipo = opc.multi ? opc.multi.tipo : opc.form ? 'application/x-www-form-urlencoded' : undefined;
    for (let i = 0; i < 6; i++) {
      const headers: Record<string, string> = { 'User-Agent': UA, Referer: BASE + 'fotservicio.php', Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (tipo) headers['Content-Type'] = tipo;
      const res = await fetch(url, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(opc.timeout ?? 25000) });
      for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const j = kv.indexOf('='); if (j > 0) this.cookies.set(kv.slice(0, j).trim(), kv.slice(j + 1).trim()); }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location')!, url).href; method = 'GET'; body = undefined; tipo = undefined;
        await res.body?.cancel(); continue;
      }
      if (!res.ok) { await res.body?.cancel(); throw new Error(`El portal respondió ${res.status} en ${ruta.split('?')[0]}`); }
      return dec.decode(await res.arrayBuffer());
    }
    throw new Error('Demasiadas redirecciones');
  }
  // GET que devuelve los bytes tal cual (fotos)
  async bajar(ruta: string, timeout = 45000): Promise<{ tipo: string; datos: Uint8Array }> {
    let url = BASE + ruta;
    for (let i = 0; i < 6; i++) {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: BASE + 'fotservicio.php', Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
      for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const j = kv.indexOf('='); if (j > 0) this.cookies.set(kv.slice(0, j).trim(), kv.slice(j + 1).trim()); }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location')!, url).href; await res.body?.cancel(); continue; }
      if (!res.ok) { await res.body?.cancel(); throw new Error(`El portal respondió ${res.status} al bajar la foto`); }
      return { tipo: res.headers.get('content-type') || '', datos: new Uint8Array(await res.arrayBuffer()) };
    }
    throw new Error('Demasiadas redirecciones');
  }
}
const pideClave = (html: string) => /name=["']?clave["'\s>]/i.test(html);
async function entrar(s: Sesion, usuario: string, clave: string) {
  await s.pedir('acceso.php');
  const html = await s.pedir('acceso.php', { form: { usuario, clave } });
  if (!pideClave(html) && /frepasos/i.test(html)) return;
  const ini = await s.pedir('inicio.php');
  if (pideClave(ini) || !/frepasos/i.test(ini)) throw new Error('No se pudo entrar en SIGMA: revisa usuario y contraseña de esta cuenta');
}

// Fotos que ya tiene el servicio en el portal: una fila por foto con la celda «Codigo»
// (comentarios <!-- CODIGO DE FOTO -->, <!-- FECHA DE EMISION -->, <!-- MOMENTO DE LA CAPTURA -->).
function fotosPortal(html: string) {
  const celda = (tr: string, nombre: string) => limpio((tr.match(new RegExp(`<!--\\s*${nombre}\\s*-->\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`, 'i')) || [])[1] ?? '');
  const filas: { codigo: string; momento: 'antes' | 'despues' | '?'; fecha: string; enlace?: string; comentario?: string; habitacion?: string; afectado?: string; tamano?: string }[] = [];
  const nd = (t: string) => (t === '(N/D)' ? '' : t);
  for (const tr of html.split(/<tr[\s>]/i).slice(1)) {
    if (!/CODIGO DE FOTO/i.test(tr)) continue;
    const codigo = celda(tr, 'CODIGO DE FOTO');
    if (!codigo || codigo === '(N/D)') continue;
    const mom = celda(tr, 'MOMENTO DE LA CAPTURA');
    const momento = /despu/i.test(mom) ? 'despues' : /antes/i.test(mom) ? 'antes' : '?';
    const href = (tr.match(/<!--\s*ENLACE IMAGEN\s*-->[\s\S]*?href="([^"]+)"/i) || [])[1];
    filas.push({ codigo, momento, fecha: celda(tr, 'FECHA DE EMISION').replace('(N/D)', ''),
      enlace: href ? href.replace(/&amp;/g, '&') : undefined, comentario: nd(celda(tr, 'COMENTARIO')),
      habitacion: nd(celda(tr, 'HABITACION')), afectado: nd(celda(tr, 'AFECTADO')), tamano: nd(celda(tr, 'TAMAÑO').replace(/\s+/g, ' ')) });
  }
  return filas;
}
const codigosFotos = (html: string) => new Set(fotosPortal(html).map((f) => f.codigo));
const resumenPortal = (html: string) => {
  const f = fotosPortal(html);
  return { total: f.length, antes: f.filter((x) => x.momento === 'antes').length, despues: f.filter((x) => x.momento === 'despues').length, fotos: f.map(({ codigo, momento, fecha }) => ({ codigo, momento, fecha })) };
};
const oculto = (html: string, nombre: string) => (html.match(new RegExp(`name="${nombre}"\\s+value="([^"]*)"`)) || [])[1] ?? '';
function avisosPortal(html: string) {
  return [...html.matchAll(/class="?msgerror"?[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((m) => limpio(m[1]))
    .filter((t) => t && !/indicaciones acerca de las fotograf/i.test(t));
}
const paginaFotos = (n: string) => `fotservicio.php?reparacion=${n}&modo=0&navid=`;
async function abrirFotos(s: Sesion, n: string) {
  const pag = await s.pedir(paginaFotos(n));
  if (pideClave(pag)) throw new Error('Sesión caducada en SIGMA');
  if (/no\s+pertenece\s+al\s+profesional/i.test(pag)) throw new Error('SIGMA dice que el servicio ya no pertenece al profesional');
  return pag;
}

// ---------- Documentos (SQL 33) ----------
const MAX_DOC = 3145728; // límite del portal en Documentos (3 MB)
const paginaDocs = (n: string) => `docservicio.php?reparacion=${n}&modo=0&navid=`;
async function abrirDocs(s: Sesion, n: string) {
  const pag = await s.pedir(paginaDocs(n));
  if (pideClave(pag)) throw new Error('Sesión caducada en SIGMA');
  if (/no\s+pertenece\s+al\s+profesional/i.test(pag)) throw new Error('SIGMA dice que el servicio ya no pertenece al profesional');
  return pag;
}
// Documentos asociados (una fila por casilla marcado[]) y estado del albarán:
// albaran = true (hay albarán escaneado) · false (se puede adjuntar) · null (el portal aún no ofrece el apartado)
function docsPortal(html: string) {
  const sinCom = html.replace(/<!--[\s\S]*?-->/g, '');
  const docs: { codigo: string; tipo: string; fecha: string; comentario: string; origen: string; tam: string }[] = [];
  for (const tr of sinCom.split(/<tr[\s>]/i).slice(1)) {
    const m = tr.match(/name="marcado\[\]"\s+value="(\d+)"/i);
    if (!m) continue;
    const c = [...tr.matchAll(/<td[^>]*class="tdet"[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => limpio(x[1]));
    docs.push({ codigo: m[1], tipo: c[1] ?? '', fecha: c[2] ?? '', comentario: (c[3] ?? '').replace(/^N\/D$/, ''), origen: c[4] ?? '', tam: c[5] ?? '' });
  }
  const alb = sinCom.match(/Albar[aá]n escaneado<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  const albaran = alb ? /href=/i.test(alb[1]) : /name="crearalbaran"/i.test(sinCom) ? false : null;
  return { albaran, puede_albaran: /name="crearalbaran"/i.test(sinCom), docs };
}
const ocultosDocs = (n: string): [string, string][] => [['reparacion', n], ['opciones', ''], ['mostrar_fecha', ''], ['mostrar_numfact', ''], ['ocultarmenu', ''], ['flag_modif_otro', '0'], ['navid', '']];
type Doc = { id: string; parte_id: string; tipo_codigo: string; tipo_nombre: string; comentario: string | null; ruta: string; nombre: string | null; mime: string | null; creado_en: string; sigma_intentos: number;
  parte: { numero_servicio: string; sigma_cuenta: string | null; estado: string } };
const nombreAscii = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'documento';

async function subirDoc(s: Sesion, d: Doc, datos: Uint8Array): Promise<{ texto: string; portal: ReturnType<typeof docsPortal> }> {
  const n = d.parte.numero_servicio;
  const antes = docsPortal(await abrirDocs(s, n));
  const ext = (d.nombre || d.ruta).split('.').pop()!.toLowerCase();
  const archivo = { campo: 'documentonew', nombre: nombreAscii(`${n}-${d.tipo_nombre}.${ext}`), datos, tipo: d.mime || 'application/octet-stream' };
  const comprobar = async () => {
    const despues = docsPortal(await abrirDocs(s, n));
    if (d.tipo_codigo === 'ALB') return { ok: despues.albaran === true && antes.albaran !== true, despues, cod: 'albarán' };
    const nuevo = despues.docs.find((x) => !antes.docs.some((y) => y.codigo === x.codigo));
    return { ok: !!nuevo, despues, cod: nuevo?.codigo ?? '' };
  };
  if (d.tipo_codigo === 'ALB') {
    if (antes.albaran === true) throw new Error('SIGMA ya tiene un albarán en este servicio (solo admite uno)');
    if (!antes.puede_albaran) throw new Error('El portal aún no deja adjuntar el albarán en este servicio (suele aparecer tras la visita)');
    await s.pedir('docservicio.php', { multi: multipart([['crearalbaran', 'Adjuntar albarán'], ...ocultosDocs(n)]) });
  } else {
    const paso2 = await s.pedir('docservicio.php', { multi: multipart([['creardocumentos', 'Nuevo Documento'], ...ocultosDocs(n)]) });
    if (!new RegExp(`<option[^>]*value="${d.tipo_codigo}"`).test(paso2.replace(/<!--[\s\S]*?-->/g, ''))) throw new Error(`El portal no ofrece el tipo «${d.tipo_nombre}» en este servicio`);
  }
  const campos: [string, string][] = d.tipo_codigo === 'ALB'
    ? [...ocultosDocs(n), ['nombredocumentonew', ''], ['grabar_albaran', 'Guardar documento']]
    : [...ocultosDocs(n), ['listatipo', d.tipo_codigo], ['tituloinicial', ''], ['comentario', d.comentario || ''], ['nombredocumentonew', ''], ['grabar', 'Guardar documento']];
  let respuesta = '';
  try {
    respuesta = await s.pedir('docservicio.php', { multi: multipart(campos, archivo), timeout: 60000 });
  } catch (err) {
    await esperar(8000);
    const r = await comprobar();
    if (r.ok) return { texto: `Subido a SIGMA (${d.tipo_nombre}) · ${r.cod} · comprobado tras un fallo del portal`, portal: r.despues };
    throw new Error(`El portal no contestó (${(err as Error).message}) y el documento no aparece: no se subió`);
  }
  const r = await comprobar();
  if (r.ok) return { texto: `Subido a SIGMA (${d.tipo_nombre})${r.cod ? ' · ' + r.cod : ''}`, portal: r.despues };
  const avisos = avisosPortal(respuesta).filter((t) => !/Acrobat/i.test(t));
  console.error('documento no aparece', n, d.id, avisos, respuesta.replace(/\s+/g, ' ').slice(0, 1500));
  throw new Error(`El portal no guardó el documento${avisos.length ? ': ' + avisos.join(' · ') : ' (sin mensaje)'}`);
}

type Foto = {
  id: string; parte_id: string; tipo: string; ruta: string; creado_en: string; sigma_intentos: number;
  parte: { numero_servicio: string; sigma_cuenta: string | null; estado: string };
};

async function subirFoto(s: Sesion, f: Foto, datos: Uint8Array): Promise<{ texto: string; resumen: ReturnType<typeof resumenPortal> }> {
  const n = f.parte.numero_servicio;
  const m = MOMENTO[f.tipo];
  const pag = await abrirFotos(s, n);
  if (!/name="?fotos2/i.test(pag)) throw new Error('La pestaña Fotografías no tiene el formulario para añadir fotos');
  const antes = codigosFotos(pag);
  const base: [string, string][] = [
    ['MAX_FILE_SIZE', String(MAX_BYTES)], ['navid', ''], ['reparacion', oculto(pag, 'reparacion') || n],
    ['afectadograbar', ''], ['numperjudicados', oculto(pag, 'numperjudicados')], ['ocultarmenu', ''], ['flag_modif_otro', '0'],
  ];
  // Parte afectada = Asegurado (0) → Continuar
  const paso2 = await s.pedir('fotservicio.php', { multi: multipart([...base, ['afectado', '0'], ['continuar', 'Continuar']]) });
  if (!/name="fotografia"/i.test(paso2)) throw new Error('El portal no mostró el formulario de la foto tras «Continuar»');
  const habitacion = (paso2.match(/<select[^>]*name="habitaciones"[\s\S]*?<option[^>]*value="([^"]*)"/i) || [])[1] ?? '';
  // Datos + archivo → Añadir Fotografía (fecha = día en que se subió la foto a KUBEL)
  const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(f.creado_en));
  const [a, mes, dia] = fecha.split('-');
  const campos: [string, string][] = [
    ...base.map(([k, v]) => [k, k === 'afectadograbar' ? (oculto(paso2, 'afectadograbar') || '0') : k === 'numperjudicados' ? (oculto(paso2, 'numperjudicados') || v) : v] as [string, string]),
    ['habitaciones', habitacion], ['dia', String(Number(dia))], ['mes', String(Number(mes))], ['ano', a],
    ['momento', m.cod], ['comentario', `${m.texto} de la reparacion`], ['actualizar', 'Añadir Fotografía'],
  ];
  const nombre = `${n}-${f.tipo}-${f.id.slice(0, 8)}.jpg`;
  const hecho = (codigo: string, extra = '') => `Subida a SIGMA (${m.texto}, Asegurado, ${dia}/${mes}/${a}) · foto ${codigo}${extra}`;
  let respuesta = '';
  try {
    respuesta = await s.pedir('fotservicio.php', { multi: multipart(campos, { campo: 'fotografia', nombre, datos }), timeout: 60000 });
  } catch (err) {
    await esperar(8000);
    const pagDespues = await abrirFotos(s, n);
    const nuevas = [...codigosFotos(pagDespues)].filter((c) => !antes.has(c));
    if (nuevas.length) return { texto: hecho(nuevas[0], ' · comprobada tras un fallo del portal'), resumen: resumenPortal(pagDespues) };
    throw new Error(`El portal no contestó (${(err as Error).message}) y la foto no aparece: no se subió`);
  }
  const pagDespues = await abrirFotos(s, n);
  const nuevas = [...codigosFotos(pagDespues)].filter((c) => !antes.has(c));
  if (nuevas.length) return { texto: hecho(nuevas[0]), resumen: resumenPortal(pagDespues) };
  const avisos = avisosPortal(respuesta);
  console.error('foto no aparece', n, f.id, avisos, respuesta.replace(/\s+/g, ' ').slice(0, 1500));
  throw new Error(`El portal no añadió la foto${avisos.length ? ': ' + avisos.join(' · ') : ' (sin mensaje)'}`);
}

// Una sesión por cuenta, abierta solo cuando hace falta
class Sesiones {
  mapa = new Map<string, { s?: Sesion; error?: string }>();
  async de(cuenta: string): Promise<Sesion> {
    let e = this.mapa.get(cuenta);
    if (!e) {
      e = {};
      try {
        const usuario = Deno.env.get(`SIGMA_${cuenta}_USUARIO`), clave = Deno.env.get(`SIGMA_${cuenta}_CLAVE`);
        if (!usuario || !clave) throw new Error('Faltan las credenciales de SIGMA en los secretos');
        const s = new Sesion(); await entrar(s, usuario, clave); e.s = s;
      } catch (err) { e.error = (err as Error).message; }
      this.mapa.set(cuenta, e);
    }
    if (e.error) throw new Error(e.error);
    return e.s!;
  }
}

// ---------------------------------------------------------------- 2 · Confirmación (v7, 07/11/2026, SQL 36)
// SOLO LECTURA. Pestaña Confirmación (confirval.php) = componente <multiasistencia-fnol> + servicio JSON de
// mawmods.plataforma-smart.com/me con el pase «ut» de la página (se pide con Referer del portal: con el de
// fotservicio.php el portal lo deja vacío). Variante completa: el clasificador de daños (urlClasi, enlace firmado
// que se abre fuera del portal) guarda su resultado, que se lee en urlWs (MAAnalizador/ObtenerResultado).
// Con el resultado, fnol-data-sorter da los datos del formulario. Lo que el formulario rellena solo sale del
// clasificador (getResults del componente). El envío (confirm-fnol) lo hace sigma-sync al aprobar en KUBEL.
const API_FNOL = 'https://mawmods.plataforma-smart.com/me';
async function paseConfir(s: Sesion, n: string) {
  // A veces el portal deja el pase vacío: se repite (la segunda vez pasando antes por la ficha, como haría una persona)
  for (let i = 0; i < 3; i++) {
    if (i) { await esperar(2500); try { await s.pedir(`repasos1.php?reparacion=${n}`); } catch { /* da igual */ } }
    const r = await fetch(BASE + `confirval.php?reparacion=${n}&modo=0`, { headers: { 'User-Agent': UA, Referer: BASE + `repasos1.php?reparacion=${n}`, Cookie: [...s.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, signal: AbortSignal.timeout(25000) });
    const html = dec.decode(await r.arrayBuffer());
    const ut = (html.match(/<multiasistencia-fnol[^>]*\sut="([^"]+)"/i) || [])[1];
    if (ut) return ut;
  }
  return null;
}
// deno-lint-ignore no-explicit-any
async function fnolApi(ut: string, ruta: string, cuerpo: unknown): Promise<any> {
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${API_FNOL}/${ruta}`, { method: 'POST', body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ut}`, Version: '3.0.0', 'User-Agent': UA, Origin: 'https://web.multiasistencia.com', Referer: BASE + 'confirval.php' } });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { throw new Error(`Respuesta rara del servicio de Confirmación (${r.status})`); }
    // «PASARELA: Error interno…» es pasajero: se repite una vez
    if (!j?.success && i === 0 && /PASARELA/i.test(JSON.stringify(j?.metadata?.errorCodes || ''))) { await esperar(3000); continue; }
    return j;
  }
}
const codigosFnol = (j: { metadata?: { errorCodes?: { code?: unknown }[] } }) => (j?.metadata?.errorCodes || []).flatMap((x) => (Array.isArray(x?.code) ? x.code : [x?.code])).filter(Boolean).map(String);
// deno-lint-ignore no-explicit-any
type Expediente = Record<string, any>;
function videoPeritacion(json: { Expediente: Expediente }) {
  const ac = (json.Expediente.Daños || []).filter((o: Expediente) => !o.Rechazado).map((o: Expediente) => ({ requestExpert: o.SolicitarPerito, reasonExpert: o.MotivoPerito }));
  return { file: { requestExpert: json.Expediente.SolicitarPerito, reasonExpert: json.Expediente.MotivoPerito }, acceptedDamages: ac };
}
// Lo que el portal rellena solo a partir del clasificador (getResults del componente)
function propuestaConfir(ex: Expediente) {
  const d = (ex.Daños || []) as Expediente[];
  const si = (v: unknown) => v === true || v === 'True';
  const perj = !!ex.Perjudicados;
  return {
    respsin: perj ? '0' : ex.TerceroCausante?.ExisteTC ? '1' : '0', respsin_fijo: perj,
    corrosion: si(ex.ExisteCorrosion) ? '1' : '0', limite: si(ex.SuperaLimite) ? '1' : '0',
    perito: d.some((r) => r.SolicitarPerito && !r.Rechazado) ? '1' : '0', estetica: d.some((r) => r.AplicarEstetica) ? '1' : '0',
    robodenuncia: '0', extdefecto: ex.FaltaMantenimiento ? '1' : '0', perjudicado: '0',
    pide_tercero: perj || !!ex.TerceroCausante?.ExisteTC,
  };
}
function resumenClasi(ex: Expediente) {
  return {
    causa: ex.DescripcionCausa ?? null, grupo: ex.DescripcionGrupoCausa ?? null, notas: Array.isArray(ex.NotasCausa) ? ex.NotasCausa : ex.NotasCausa ? [ex.NotasCausa] : [],
    danos: ((ex.Daños || []) as Expediente[]).map((r) => ({
      bien: r.CodigoBien, descripcion: r.DescripcionDaño, tipo: r.DescripcionTipoDaño, naturaleza: r.DescripcionNaturalezaDaño,
      gremio: r.DescripcionGremio, consecuenciales: r.DescripcionGremiosConsecuenciales || [],
      cubierto: !r.Rechazado && !(r.CodigosRechazo || []).length, rechazo: [].concat(r.MotivoRechazo || []).filter(Boolean),
      parcial: r.RechazoParcial || '', total: r.RechazoTotal || '', perito: !!r.SolicitarPerito, estetica: !!r.AplicarEstetica,
    })),
    perjudicados: !!ex.Perjudicados, tercero_causante: !!ex.TerceroCausante?.ExisteTC, perito: !!ex.SolicitarPerito, motivo_perito: ex.TextoMotivoPerito || ex.MotivoPerito || '',
    supera_limite: ex.SuperaLimite === true || ex.SuperaLimite === 'True', corrosion: ex.ExisteCorrosion === true || ex.ExisteCorrosion === 'True',
    falta_mantenimiento: !!ex.FaltaMantenimiento, stop: !!ex.StopConfirmacion, segunda_vivienda: !!ex.SegundaVivienda,
  };
}
async function leerConfirmacion(s: Sesion, n: string): Promise<Record<string, unknown>> {
  const ut = await paseConfir(s, n);
  if (!ut) throw new Error('No se pudo abrir la pestaña Confirmación de este servicio');
  const ini = await fnolApi(ut, 'fnol-initial-data', { reparation: n });
  const leerFt = async () => { try { const f = await fnolApi(ut, 'fasttrack-initial-data', { reparation: n }); return f?.success ? f.data : null; } catch { return null; } };
  if (!ini?.success) {
    if (codigosFnol(ini).includes('FASTTRACK')) {
      const f = await leerFt();
      if (!f) return { estado: 'no_aplica', motivo: 'El portal no da los datos de la confirmación rápida' };
      return { estado: 'rapida', siniestro: f.sinisterData ?? null, confirmacion: f.confirmationData ?? null, aviso: f.infoMessage || null,
        pide_contacto: String(f.contactClient) === '1', pide_primera_visita: String(f.firstVisit) === '1' };
    }
    return { estado: 'no_aplica', motivo: codigosFnol(ini).join(' · ') || 'El portal no deja confirmar ahora' };
  }
  const d = ini.data || {};
  const leerWs = async () => {
    if (!d.urlWs) return { hecho: false, motivo: 'SIGMA no da el resultado del clasificador' };
    try {
      const w = JSON.parse(await (await fetch(d.urlWs, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) })).text());
      if (w?.Respuesta?.Resultado !== 'OK') return { hecho: false, motivo: w?.Respuesta?.CodigoError || 'sin resultado' };
      return { hecho: true, json: w };
    } catch (err) { return { hecho: false, motivo: `No se pudo leer el resultado (${(err as Error).message})` }; }
  };
  if (String(d.confirmed) === '1') {
    const w = await leerWs();
    return { estado: 'confirmado', confirmacion: d.confirmationData ?? null, siniestro: d.sinisterData ?? null,
      clasificador: w.hecho ? { hecho: true, ...resumenClasi(w.json!.Expediente) } : { hecho: false } };
  }
  const ft = await leerFt();
  const base = {
    estado: 'completa', siniestro: ft?.sinisterData ?? d.sinisterData ?? null,
    confirmacion: { ...(ft?.confirmationData || {}), ...Object.fromEntries(Object.entries(d.confirmationData || {}).filter(([, v]) => v !== '' && v != null)) },
    limite: String(d.limitValue ?? d.confirmationData?.limitValue ?? '').trim() || null,
    url_clasi: d.urlClasi ? (/visualizacion=/.test(d.urlClasi) ? d.urlClasi : d.urlClasi + '&visualizacion=0') : null,
    aviso_tramitacion: d.errorMessage === 'MENSA_CONFIRPOSITIVA',
  };
  const w = await leerWs();
  if (!w.hecho) return { ...base, clasificador: { hecho: false, motivo: w.motivo } };
  const ex = w.json!.Expediente;
  const so = await fnolApi(ut, 'fnol-data-sorter', { reparation: n, gCause: ex.GrupoCausa, cCause: ex.CodigoCausa, warranty: ex.Daños?.[0]?.Garantias?.[0], videoExpertise: videoPeritacion(w.json!) });
  const sd = so?.data || {};
  return { ...base, clasificador: { hecho: true, ...resumenClasi(ex) }, propuesta: propuestaConfir(ex),
    formulario: so?.success ? {
      pide_contacto: String(sd.clientContact) === '1', pide_primera_visita: String(sd.firstVisit) === '1',
      tercero: sd.thirdPartyData ?? null, tipos_tercero: sd.injuredList ?? d.injuredList ?? [],
      localizacion: String(sd.isPositiveConfirmationOk) === '1' && String(sd.seeLocation) !== '1',
      videoperitacion: String(sd.visualizationData?.videoExpertise?.display) === '1'
        ? { lista: sd.videoExpertiseData?.videoExpertiseList ?? [], enlace: sd.videoExpertiseData?.link ?? null } : false,
      con_tercero: ['2', '3', '4', '5'].includes(String((sd.confirmationData || d.confirmationData || {}).typeInvolved)) || Number(sd.confirmFnol ?? d.confirmFnol) === 1,
    } : { error: codigosFnol(so).join(' · ') || 'fnol-data-sorter no respondió' } };
}

async function procesar(admin: SupabaseClient, secreto: string) {
  const t0 = Date.now();
  const ahora = () => new Date().toISOString();
  const marcar = (id: string, d: Record<string, unknown>) => admin.from('fotos').update({ ...d, sigma_actualizado_en: ahora() }).eq('id', id);
  const guardarPortal = (parteId: string, r: ReturnType<typeof resumenPortal>) =>
    admin.from('partes').update({ sigma_fotos: r, sigma_fotos_en: ahora(), sigma_fotos_pedir: null }).eq('id', parteId);
  // Subidas a medias hace más de 10 min: no se reintentan solas (podría duplicarse en el portal)
  await admin.from('fotos').update({ sigma_estado: 'error', sigma_resultado: 'Subida interrumpida: mira la pestaña Fotografías del servicio en SIGMA antes de reintentar' })
    .eq('sigma_estado', 'enviando').lt('sigma_actualizado_en', new Date(Date.now() - 10 * 60000).toISOString());
  const ses = new Sesiones();
  let subidas = 0, leidos = 0; const errores: Record<string, string[]> = {};

  // 1) Fotos en cola, de una en una
  while (Date.now() - t0 < TOPE_MS) {
    const { data: sig, error } = await admin.from('fotos')
      .select('id, parte_id, tipo, ruta, creado_en, sigma_intentos, parte:partes!inner(numero_servicio, sigma_cuenta, estado)')
      .eq('sigma_estado', 'aprobado').order('sigma_aprobado_en').order('creado_en').limit(1);
    if (error) throw error;
    if (!sig?.length) break;
    const f = sig[0] as unknown as Foto;
    const { data: mia } = await admin.from('fotos').update({ sigma_estado: 'enviando', sigma_actualizado_en: ahora() })
      .eq('id', f.id).eq('sigma_estado', 'aprobado').select('id');
    if (!mia?.length) continue; // otra pasada la cogió
    const intentos = (f.sigma_intentos ?? 0) + 1;
    if (['cerrado', 'anulado'].includes(f.parte.estado)) { await marcar(f.id, { sigma_estado: 'omitido', sigma_resultado: `No se sube: el servicio está ${f.parte.estado}` }); continue; }
    if (!MOMENTO[f.tipo]) { await marcar(f.id, { sigma_estado: 'omitido', sigma_resultado: 'Las fotos de factura no van a la pestaña Fotografías' }); continue; }
    const cuenta = f.parte.sigma_cuenta ?? '';
    try {
      if (!CUENTAS[cuenta]) throw new Error('El servicio no tiene cuenta de SIGMA (Valladolid/Palencia)');
      const { data: blob, error: eDesc } = await admin.storage.from('fotos').download(f.ruta.replace(/^fotos\//, ''));
      if (eDesc || !blob) {
        // La app puede guardar la fila antes de terminar de subir el archivo: se espera hasta 30 min
        if (Date.now() - new Date(f.creado_en).getTime() < 30 * 60000) { await marcar(f.id, { sigma_estado: 'aprobado' }); break; }
        throw new Error('No se encuentra el archivo de la foto en KUBEL');
      }
      const datos = new Uint8Array(await blob.arrayBuffer());
      if (!(datos[0] === 0xFF && datos[1] === 0xD8)) throw new Error('La foto no es JPEG (SIGMA solo admite JPEG)');
      if (datos.length > MAX_BYTES) throw new Error('La foto pasa de 6 MB (límite de SIGMA)');
      const s = await ses.de(cuenta);
      const r = await subirFoto(s, f, datos);
      await marcar(f.id, { sigma_estado: 'enviado', sigma_resultado: r.texto, sigma_enviado_en: ahora(), sigma_intentos: intentos });
      await guardarPortal(f.parte_id, r.resumen);
      subidas++;
    } catch (err) {
      const msg = (err as Error).message;
      await marcar(f.id, { sigma_estado: 'error', sigma_resultado: msg, sigma_intentos: intentos });
      (errores[cuenta || '?'] ??= []).push(`${f.parte.numero_servicio}: ${msg}`);
    }
  }

  // 1b) Documentos en cola, de uno en uno
  const marcarDoc = (id: string, d: Record<string, unknown>) => admin.from('documentos_sigma').update({ ...d, sigma_actualizado_en: ahora() }).eq('id', id);
  await admin.from('documentos_sigma').update({ sigma_estado: 'error', sigma_resultado: 'Subida interrumpida: mira la pestaña Documentos del servicio en SIGMA antes de reintentar' })
    .eq('sigma_estado', 'enviando').lt('sigma_actualizado_en', new Date(Date.now() - 10 * 60000).toISOString());
  while (Date.now() - t0 < TOPE_MS) {
    const { data: sig, error } = await admin.from('documentos_sigma')
      .select('id, parte_id, tipo_codigo, tipo_nombre, comentario, ruta, nombre, mime, creado_en, sigma_intentos, parte:partes!inner(numero_servicio, sigma_cuenta, estado)')
      .eq('sigma_estado', 'aprobado').order('sigma_aprobado_en').order('creado_en').limit(1);
    if (error) throw error;
    if (!sig?.length) break;
    const d = sig[0] as unknown as Doc;
    const { data: mio } = await admin.from('documentos_sigma').update({ sigma_estado: 'enviando', sigma_actualizado_en: ahora() })
      .eq('id', d.id).eq('sigma_estado', 'aprobado').select('id');
    if (!mio?.length) continue;
    const intentos = (d.sigma_intentos ?? 0) + 1;
    const cuenta = d.parte.sigma_cuenta ?? '';
    try {
      if (['cerrado', 'anulado'].includes(d.parte.estado)) throw new Error(`El servicio está ${d.parte.estado}`);
      if (!CUENTAS[cuenta]) throw new Error('El servicio no tiene cuenta de SIGMA (Valladolid/Palencia)');
      const { data: blob, error: eDesc } = await admin.storage.from('fotos').download(d.ruta);
      if (eDesc || !blob) throw new Error('No se encuentra el archivo del documento en KUBEL');
      const datos = new Uint8Array(await blob.arrayBuffer());
      if (datos.length > MAX_DOC) throw new Error('El documento pasa de 3 MB (límite de SIGMA)');
      const r = await subirDoc(await ses.de(cuenta), d, datos);
      await marcarDoc(d.id, { sigma_estado: 'enviado', sigma_resultado: r.texto, sigma_enviado_en: ahora(), sigma_intentos: intentos });
      await admin.from('partes').update({ sigma_docs: { ...r.portal, leido: ahora() } }).eq('id', d.parte_id);
      subidas++;
    } catch (err) {
      const msg = (err as Error).message;
      await marcarDoc(d.id, { sigma_estado: 'error', sigma_resultado: msg, sigma_intentos: intentos });
      (errores[cuenta || '?'] ??= []).push(`${d.parte.numero_servicio}: ${msg}`);
    }
  }

  // 2) «↻ Comprobar en SIGMA»: leer lo que tiene el portal (fotos y documentos)
  while (Date.now() - t0 < TOPE_MS) {
    const { data: ps } = await admin.from('partes').select('id, numero_servicio, sigma_cuenta').not('sigma_fotos_pedir', 'is', null).limit(1);
    if (!ps?.length) break;
    const p = ps[0];
    try {
      if (!CUENTAS[p.sigma_cuenta ?? '']) throw new Error('sin cuenta');
      const sp = await ses.de(p.sigma_cuenta!);
      const pag = await abrirFotos(sp, p.numero_servicio);
      const docs = docsPortal(await abrirDocs(sp, p.numero_servicio));
      await admin.from('partes').update({ sigma_docs: { ...docs, leido: ahora() } }).eq('id', p.id);
      await guardarPortal(p.id, resumenPortal(pag));
      leidos++;
    } catch (err) {
      await admin.from('partes').update({ sigma_fotos_pedir: null, sigma_fotos: { error: (err as Error).message }, sigma_fotos_en: ahora() }).eq('id', p.id);
    }
  }

  // 3) v7 (SQL 36): «Leer de SIGMA» del paso 2 · Confirmación (partes.sigma_confir_pedir). Solo lectura.
  while (Date.now() - t0 < TOPE_MS) {
    const { data: ps } = await admin.from('partes').select('id, numero_servicio, sigma_cuenta, sigma_confirmado_en').not('sigma_confir_pedir', 'is', null).limit(1);
    if (!ps?.length) break;
    const p = ps[0];
    let r: Record<string, unknown>;
    try {
      if (!CUENTAS[p.sigma_cuenta ?? '']) throw new Error('El servicio no tiene cuenta de SIGMA');
      r = await leerConfirmacion(await ses.de(p.sigma_cuenta!), p.numero_servicio);
    } catch (err) { r = { estado: 'error', error: (err as Error).message }; }
    const upd: Record<string, unknown> = { sigma_confir: { ...r, leido: ahora() }, sigma_confir_en: ahora(), sigma_confir_pedir: null };
    if (r.estado === 'confirmado' && !p.sigma_confirmado_en) upd.sigma_confirmado_en = ahora();
    await admin.from('partes').update(upd).eq('id', p.id);
    leidos++;
  }

  for (const [cuenta, lista] of Object.entries(errores)) {
    try {
      await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/notificar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kubel-secreto': secreto },
        body: JSON.stringify({ tabla: 'sigma', evento: 'resumen', nuevo: { cuenta, nombre: CUENTAS[cuenta] ?? cuenta, error: `Fotos a SIGMA fallidas · ${lista.slice(0, 2).join(' · ')}${lista.length > 2 ? ' …' : ''}` } }),
      });
    } catch (err) { console.error('aviso fotos', (err as Error).message); }
  }
  return { subidas, leidos, errores: Object.values(errores).flat().length, segundos: Math.round((Date.now() - t0) / 1000) };
}

// ---------- v6 · Traer a KUBEL las fotos del portal (SQL 35) ----------
const TOPE_IMPORTAR_MS = 100000;
const esImagen = (d: Uint8Array) => (d[0] === 0xFF && d[1] === 0xD8) ? 'image/jpeg' : (d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4E && d[3] === 0x47) ? 'image/png'
  : (d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46) ? 'image/gif' : null;
const fechaISO = (f: string) => { const m = f.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
const errorDeSesion = (m: string) => /No se pudo entrar|credenciales|Sesión caducada|respondió 5\d\d/i.test(m);

// Baja una foto del portal. Si pdf.php devolviera una página en vez de la imagen, sigue su <img>.
async function bajarFotoPortal(s: Sesion, enlace: string) {
  let r = await s.bajar(enlace);
  if (!esImagen(r.datos)) {
    const html = dec.decode(r.datos);
    if (pideClave(html)) throw new Error('Sesión caducada en SIGMA');
    const src = (html.match(/<img[^>]+src="([^"]+)"/i) || [])[1];
    if (!src) throw new Error('El portal no devolvió una imagen');
    r = await s.bajar(new URL(src.replace(/&amp;/g, '&'), BASE + enlace).href.replace(BASE, ''));
    if (!esImagen(r.datos)) throw new Error('El portal no devolvió una imagen');
  }
  return { datos: r.datos, mime: esImagen(r.datos)! };
}

async function importarFotos(admin: SupabaseClient) {
  const t0 = Date.now();
  const ahora = () => new Date().toISOString();
  const ses = new Sesiones();
  let leidos = 0, bajadas = 0, deKubel = 0, errores = 0; const avisos: string[] = [];
  const cuentaOk = (c: string | null) => !!c && !!CUENTAS[c];
  while (Date.now() - t0 < TOPE_IMPORTAR_MS) {
    // a) una foto pendiente de bajar
    const hace10 = new Date(Date.now() - 10 * 60000).toISOString();
    const { data: pend, error: ep } = await admin.from('fotos_portal')
      .select('id, parte_id, codigo, enlace, intentos, parte:partes!inner(numero_servicio, sigma_cuenta)')
      .eq('estado', 'pendiente').or(`intentado_en.is.null,intentado_en.lt.${hace10}`).order('creado_en').limit(1);
    if (ep) throw ep;
    if (pend?.length) {
      const f = pend[0] as unknown as { id: string; parte_id: string; codigo: string; enlace: string | null; intentos: number; parte: { numero_servicio: string; sigma_cuenta: string | null } };
      const intentos = f.intentos + 1;
      await admin.from('fotos_portal').update({ intentado_en: ahora(), intentos }).eq('id', f.id);
      try {
        if (!cuentaOk(f.parte.sigma_cuenta)) throw new Error('El servicio no tiene cuenta de SIGMA');
        if (!f.enlace) throw new Error('El portal no da enlace para esta foto');
        const r = await bajarFotoPortal(await ses.de(f.parte.sigma_cuenta!), f.enlace);
        const ruta = `portal/${f.parte_id}/${f.codigo}.${r.mime === 'image/png' ? 'png' : r.mime === 'image/gif' ? 'gif' : 'jpg'}`;
        const { error: eu } = await admin.storage.from('fotos').upload(ruta, r.datos, { contentType: r.mime, upsert: true });
        if (eu) throw new Error('No se pudo guardar en KUBEL: ' + eu.message);
        await admin.from('fotos_portal').update({ estado: 'descargada', ruta, mime: r.mime, bytes: r.datos.length, error: null, descargada_en: ahora() }).eq('id', f.id);
        bajadas++;
      } catch (err) {
        const msg = (err as Error).message;
        if (errorDeSesion(msg)) { avisos.push(`${f.parte.numero_servicio}: ${msg}`); break; } // se reintenta en la próxima pasada
        await admin.from('fotos_portal').update({ error: msg, ...(intentos >= 3 ? { estado: 'error' } : {}) }).eq('id', f.id);
        errores++;
      }
      continue;
    }
    // b) siguiente servicio a leer: pedidos por la oficina → nunca leídos → abiertos leídos hace > 12 h
    const sel = () => admin.from('partes').select('id, numero_servicio, sigma_cuenta').in('sigma_cuenta', Object.keys(CUENTAS)).not('numero_servicio', 'is', null);
    let { data: ps } = await sel().not('sigma_fotos_importar_pedir', 'is', null).order('sigma_fotos_importar_pedir').limit(1);
    if (!ps?.length) ({ data: ps } = await sel().is('sigma_fotos_importar_en', null).order('creado_en', { ascending: false }).limit(1));
    if (!ps?.length) ({ data: ps } = await sel().not('estado', 'in', '(cerrado,anulado)').lt('sigma_fotos_importar_en', new Date(Date.now() - 12 * 3600000).toISOString()).order('sigma_fotos_importar_en').limit(1));
    if (!ps?.length) break;
    const p = ps[0];
    try {
      const pag = await abrirFotos(await ses.de(p.sigma_cuenta!), p.numero_servicio);
      const enPortal = fotosPortal(pag);
      const { data: ya } = await admin.from('fotos_portal').select('codigo, estado').eq('parte_id', p.id);
      const conocidas = new Map((ya || []).map((x) => [x.codigo, x.estado]));
      // fotos que subió la propia KUBEL: «… · foto NNN» en fotos.sigma_resultado
      const { data: propias } = await admin.from('fotos').select('id, ruta, sigma_resultado').eq('parte_id', p.id).eq('sigma_estado', 'enviado');
      const deK = new Map<string, { id: string; ruta: string }>();
      for (const x of propias || []) { const m = String(x.sigma_resultado || '').match(/foto (\d+)/); if (m) deK.set(m[1], { id: x.id, ruta: x.ruta }); }
      const nuevas = enPortal.filter((f) => !conocidas.has(f.codigo)).map((f) => {
        const k = deK.get(f.codigo);
        if (k) deKubel++;
        return { parte_id: p.id, codigo: f.codigo, momento: f.momento, fecha_foto: fechaISO(f.fecha), comentario: f.comentario || null, habitacion: f.habitacion || null,
          afectado: f.afectado || null, tamano: f.tamano || null, enlace: f.enlace || null,
          estado: k ? 'kubel' : 'pendiente', foto_id: k ? k.id : null, ruta: k ? k.ruta.replace(/^fotos\//, '') : null };
      });
      if (nuevas.length) { const { error } = await admin.from('fotos_portal').upsert(nuevas, { onConflict: 'parte_id,codigo', ignoreDuplicates: true }); if (error) throw error; }
      // las que ya no están en el portal; y las retiradas que han vuelto
      const codigos = new Set(enPortal.map((f) => f.codigo));
      const fuera = [...conocidas].filter(([c, e]) => !codigos.has(c) && e !== 'retirada').map(([c]) => c);
      if (fuera.length) await admin.from('fotos_portal').update({ estado: 'retirada' }).eq('parte_id', p.id).in('codigo', fuera);
      const vuelven = [...conocidas].filter(([c, e]) => codigos.has(c) && e === 'retirada').map(([c]) => c);
      if (vuelven.length) await admin.from('fotos_portal').update({ estado: 'pendiente', intentos: 0, error: null }).eq('parte_id', p.id).in('codigo', vuelven).is('ruta', null);
      if (vuelven.length) await admin.from('fotos_portal').update({ estado: 'descargada' }).eq('parte_id', p.id).in('codigo', vuelven).not('ruta', 'is', null);
      const r = resumenPortal(pag);
      await admin.from('partes').update({ sigma_fotos_importar_en: ahora(), sigma_fotos_importar_pedir: null, sigma_fotos_importar_error: null, sigma_fotos: r, sigma_fotos_en: ahora() }).eq('id', p.id);
      leidos++;
    } catch (err) {
      const msg = (err as Error).message;
      if (errorDeSesion(msg)) { avisos.push(`${p.numero_servicio}: ${msg}`); break; }
      await admin.from('partes').update({ sigma_fotos_importar_en: ahora(), sigma_fotos_importar_pedir: null, sigma_fotos_importar_error: msg }).eq('id', p.id);
      errores++;
    }
  }
  return { modo: 'importar', leidos, bajadas, deKubel, errores, avisos, segundos: Math.round((Date.now() - t0) / 1000) };
}

let secreto: string | null = null;
async function leerSecreto() {
  if (secreto) return secreto;
  const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });
  try { const [f] = await sql`select valor from privado.ajustes where clave = 'notif_secreto'`; secreto = f?.valor ?? null; }
  finally { await sql.end(); }
  return secreto;
}

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const s = await leerSecreto();
  if (!s || req.headers.get('x-kubel-secreto') !== s) return new Response('no', { status: 401 });
  const url = new URL(req.url);
  try {
    // Diagnóstico de solo lectura
    const ver = url.searchParams.get('ver');
    if (ver) {
      const cuenta = url.searchParams.get('cuenta') || 'VLL';
      const ses = new Sesiones();
      const pag = await abrirFotos(await ses.de(cuenta), ver);
      const i = pag.search(/CODIGO DE FOTO/i);
      return json({ servicio: ver, cuenta, resumen: resumenPortal(pag), fotos: fotosPortal(pag),
        formulario: /name="?fotos2/i.test(pag), fragmento: i >= 0 ? pag.slice(Math.max(0, i - 2500), i + 2500).replace(/\s+/g, ' ') : pag.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\s+/g, ' ').slice(0, 5000) });
    }
    // v6: diagnóstico de solo lectura: baja la primera foto del portal y dice qué devuelve (no guarda nada)
    const verfoto = url.searchParams.get('verfoto');
    if (verfoto) {
      const ses = new Sesiones();
      const s2 = await ses.de(url.searchParams.get('cuenta') || 'VLL');
      const fs = fotosPortal(await abrirFotos(s2, verfoto));
      const f = fs.find((x) => x.enlace);
      if (!f) return json({ servicio: verfoto, fotos: fs, nota: 'sin enlaces' });
      const r = await s2.bajar(f.enlace!);
      return json({ servicio: verfoto, fotos: fs, primera: f.codigo, tipo: r.tipo, bytes: r.datos.length, imagen: esImagen(r.datos),
        inicio: esImagen(r.datos) ? [...r.datos.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ') : dec.decode(r.datos.slice(0, 3000)).replace(/\s+/g, ' ') });
    }
    if (url.searchParams.get('importar')) {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
      return json(await importarFotos(admin));
    }
    const verconfir2 = url.searchParams.get('leerconfir');
    if (verconfir2) { // v7: lo mismo que guarda «Leer de SIGMA», sin guardar nada
      const ses = new Sesiones();
      return json(await leerConfirmacion(await ses.de(url.searchParams.get('cuenta') || 'VLL'), verconfir2));
    }
    // v6.1 (07/11): diagnóstico de SOLO LECTURA de la Confirmación completa (confirval.php y clasificador de daños).
    //   ?verclasi=N&cuenta=VLL → atributos del componente, scripts, fnol-initial-data en bruto, urlWs y urlClasi.
    //   &asset=URL[&desde=0&largo=150000][&buscar=regex] → texto de un recurso de plataforma-smart / multiasistencia.
    //   &api=ruta → POST de solo lectura al servicio JSON del componente con {reparation:N} (solo rutas *-initial-data,
    //   *data-sorter* no: se limita a lecturas). Nunca llama a confirm-fnol ni a fasttrack-confirm.
    const verclasi = url.searchParams.get('verclasi');
    if (verclasi) {
      const cuenta = url.searchParams.get('cuenta') || 'VLL';
      const API = 'https://mawmods.plataforma-smart.com/me';
      const permitido = (u: string) => /^https:\/\/([a-z0-9-]+\.)*(plataforma-smart\.com|multiasistencia\.com)\//i.test(u);
      const recorte = (t: string) => {
        const desde = Number(url.searchParams.get('desde') || 0), largo = Math.min(Number(url.searchParams.get('largo') || 150000), 400000);
        const buscar = url.searchParams.get('buscar');
        if (buscar) {
          const re = new RegExp(buscar, 'gi'); const ctx = Number(url.searchParams.get('ctx') || 600);
          return { largo_total: t.length, coincidencias: [...t.matchAll(re)].slice(0, 40).map((m) => ({ pos: m.index, texto: t.slice(Math.max(0, m.index! - ctx), m.index! + ctx) })) };
        }
        return { largo_total: t.length, desde, texto: t.slice(desde, desde + largo) };
      };
      const asset = url.searchParams.get('asset');
      if (asset) {
        if (!permitido(asset)) return json({ error: 'dominio no permitido' }, 400);
        const r = await fetch(asset, { headers: { 'User-Agent': UA, Referer: BASE + 'confirval.php' }, signal: AbortSignal.timeout(30000) });
        return json({ asset, status: r.status, cabeceras: Object.fromEntries(r.headers), ...recorte(await r.text()) });
      }
      const ses = new Sesiones();
      const s2 = await ses.de(cuenta);
      // Con el Referer de fotservicio.php el portal deja el pase (ut) vacío: se pide como lo hace sigma-sync
      const rc = await fetch(BASE + `confirval.php?reparacion=${verclasi}&modo=0`, { headers: { 'User-Agent': UA, Referer: BASE, Cookie: [...s2.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, signal: AbortSignal.timeout(25000) });
      const html = dec.decode(await rc.arrayBuffer());
      const comp = (html.match(/<multiasistencia-fnol[^>]*>/i) || [])[0] || null;
      const ut = (comp?.match(/\sut="([^"]+)"/i) || [])[1] || null;
      const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/gi)].map((m) => m[1]);
      const cab = { 'Content-Type': 'application/json', Authorization: `Bearer ${ut}`, Version: '3.0.0', 'User-Agent': UA, Origin: 'https://web.multiasistencia.com', Referer: BASE + 'confirval.php' };
      const api = url.searchParams.get('api');
      if (api) {
        if (!/^[a-z-]*(initial-data|translations[^/]*)$/i.test(api)) return json({ error: 'solo lecturas *-initial-data' }, 400);
        const r = await fetch(`${API}/${api}`, { method: 'POST', headers: cab, body: JSON.stringify({ reparation: verclasi }), signal: AbortSignal.timeout(20000) });
        return json({ api, status: r.status, ...recorte(await r.text()) });
      }
      const r = await fetch(`${API}/fnol-initial-data`, { method: 'POST', headers: cab, body: JSON.stringify({ reparation: verclasi }), signal: AbortSignal.timeout(20000) });
      const ini = await r.text();
      let d: Record<string, unknown> = {};
      try { d = JSON.parse(ini)?.data || {}; } catch { /* bruto */ }
      const leer = async (u: unknown) => {
        if (typeof u !== 'string' || !permitido(u)) return { url: u ?? null, nota: 'sin URL o dominio no permitido' };
        try {
          const x = await fetch(u, { headers: { 'User-Agent': UA, Referer: BASE + 'confirval.php' }, signal: AbortSignal.timeout(20000) });
          const t = await x.text();
          return { url: u, status: x.status, tipo: x.headers.get('content-type'), scripts: [...t.matchAll(/<script[^>]*src="([^"]+)"/gi)].map((m) => m[1]), texto: t.slice(0, 20000) };
        } catch (err) { return { url: u, error: (err as Error).message }; }
      };
      const sin = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/\s+/g, ' ');
      return json({ servicio: verclasi, cuenta, componente: comp?.replace(/\sut="[^"]+"/i, ' ut="…"'), scripts, inicial_status: r.status,
        inicial: ini.slice(0, 60000), urlWs: await leer(d.urlWs), urlClasi: await leer(d.urlClasi), pagina: sin.slice(0, 4000) });
    }
    // Diagnóstico de solo lectura de la pestaña Documentos (solo GET)
    const verdocs = url.searchParams.get('verdocs');
    if (verdocs) {
      const cuenta = url.searchParams.get('cuenta') || 'VLL';
      const ses = new Sesiones();
      const s2 = await ses.de(cuenta);
      const ruta = url.searchParams.get('ruta') || `docservicio.php?reparacion=${verdocs}&modo=0&navid=`;
      let pag = await s2.pedir(ruta);
      if (url.searchParams.get('paso2')) {
        // «Nuevo Documento»: solo abre el formulario del documento, no guarda nada
        const alb = url.searchParams.get('paso2') === 'albaran';
        pag = await s2.pedir('docservicio.php', { multi: multipart([alb ? ['crearalbaran', 'Adjuntar albarán'] : ['creardocumentos', 'Nuevo Documento'], ['reparacion', verdocs], ['opciones', ''],
          ['mostrar_fecha', ''], ['mostrar_numfact', ''], ['ocultarmenu', ''], ['flag_modif_otro', '0'], ['navid', '']]) });
      }
      const sin = pag.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/\s+/g, ' ');
      const forms = [...sin.matchAll(/<form[\s\S]*?<\/form>/gi)].map((m) => m[0].slice(0, 6000));
      const selects = [...sin.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/gi)].map((m) => ({
        nombre: m[1], opciones: [...m[2].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)].map((o) => [o[1], limpio(o[2])]) }));
      const i = sin.search(/Documentos asociados/i);
      const j = sin.lastIndexOf('Nuevo Documento</div>');
      const scripts = [...pag.matchAll(/<script[\s\S]*?<\/script>/gi)].map((m) => m[0]).filter((x) => /recargar|listatipo|adm\./i.test(x)).map((x) => x.replace(/\s+/g, ' ').slice(0, 4000));
      const k = sin.search(/type="file"/i);
      if (url.searchParams.get('paso2')) return json({ ruta, scripts, archivo: k >= 0 ? sin.slice(Math.max(0, k - 2500), k + 2000).replace(/<!--[\s\S]*?-->/g, '').replace(/<option[^>]*>[^<]*<\/option>/g, '') : null, nuevo: j >= 0 ? sin.slice(j, sin.indexOf('</form>', j) + 7).replace(/<!--[\s\S]*?-->/g, '') : null });
      return json({ ruta, portal: docsPortal(pag), largo: pag.length, selects, forms, enlaces: [...sin.matchAll(/href="([^"]*\.php[^"]*)"/gi)].map((m) => m[1]).filter((h) => !/inicio|acceso/.test(h)).slice(0, 60),
        tabla: i >= 0 ? sin.slice(i, i + 6000) : sin.slice(0, 6000) });
    }
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    return json(await procesar(admin, s));
  } catch (err) {
    console.error('sigma-fotos', err);
    return json({ error: (err as Error).message }, 500);
  }
});
