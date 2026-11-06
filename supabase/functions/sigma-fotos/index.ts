// KUBEL — Robot sigma-fotos (v5, 06/11/2026). Sube a SIGMA las fotos y los DOCUMENTOS (SQL 33: albarán con
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
  const filas: { codigo: string; momento: 'antes' | 'despues' | '?'; fecha: string }[] = [];
  for (const tr of html.split(/<tr[\s>]/i).slice(1)) {
    if (!/CODIGO DE FOTO/i.test(tr)) continue;
    const codigo = celda(tr, 'CODIGO DE FOTO');
    if (!codigo || codigo === '(N/D)') continue;
    const mom = celda(tr, 'MOMENTO DE LA CAPTURA');
    const momento = /despu/i.test(mom) ? 'despues' : /antes/i.test(mom) ? 'antes' : '?';
    filas.push({ codigo, momento, fecha: celda(tr, 'FECHA DE EMISION').replace('(N/D)', '') });
  }
  return filas;
}
const codigosFotos = (html: string) => new Set(fotosPortal(html).map((f) => f.codigo));
const resumenPortal = (html: string) => {
  const f = fotosPortal(html);
  return { total: f.length, antes: f.filter((x) => x.momento === 'antes').length, despues: f.filter((x) => x.momento === 'despues').length, fotos: f };
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
