// KUBEL — Robot de lectura del portal SIGMA (Multiasistencia, proveedores).
// Entra con cada cuenta (Valladolid, Palencia), lee "Servicios en curso" y las fichas,
// y vuelca en Supabase: partes nuevos, cambios y servicios que dejan de estar en curso.
// Si el portal tiene servicios ofrecidos pendientes de confirmación, los ACEPTA TODOS y avisa a la oficina.
// Marca los partes SIN PRIMER CONTACTO (Gestión repaso del portal + estado 15).
// Marca las CADUCADAS / CADUCAN HOY (filtro Caducidad del listado: REDES, RESTO, CLIENTE) y cuándo salen.
// También manda a SIGMA lo que la oficina ha aprobado en "Envíos a SIGMA" (Repaso e Informar citas).
// Marca los servicios con el Repaso BLOQUEADO por "Documento de Iva pendiente de Validar" (partes.sigma_iva_pendiente):
// lo comprueba en el portal (~20 servicios por cuenta y pasada) y al fallar un Repaso. La oficina no puede hacer Repaso
// de esos servicios; en su lugar envía un mensaje a tramitación (envío tipo 'tramitacion' → pestaña Su Gestor/Tramitador).
// Pasa a CERRADO los que SIGMA cierra y a ANULADO los que ya no son nuestros (fuera de curso + ficha con
// "La Reparación No Pertenece Al Profesional", pedida siempre con la cuenta del propio servicio). Los reabre si vuelven.
// Lo llama pg_cron cada 15 minutos con la cabecera secreta x-kubel-secreto.
// ?prueba=1  → lee el portal pero NO escribe ni acepta nada y devuelve un resumen.
// CONFIRMACIÓN (v23, 23/10/2026): cada informe nuevo de un servicio SIGMA sin confirmar crea un borrador 'confirmacion'
// (variante rápida = la manda el robot al aprobar; completa = la hace la oficina en el portal y el robot lo comprueba).
// v24 (27/10/2026): un Repaso que SIGMA rechaza con el código 1212 (aplazar un siniestro sin confirmar) se descarta solo.
// v25 (30/10/2026): un «Documento de Iva pendiente de Validar» en la bitácora posterior a la última comprobación de IVA hace
//   que ese servicio se compruebe en la pasada siguiente, antes que los demás (antes los libres se miraban cada 6 h).
// v26 (04/11/2026): un Repaso que SIGMA rechaza por estado 6 «Aplazamiento Pte. Cia./Perito» o 16 «Confirmación o Presupuesto
//   pendiente de tramitar» se descarta solo, sin error ni aviso (la oficina lo pide de nuevo cuando se desbloquee).
// ?verconfir=N&cuenta=VLL → solo lectura: estado de la Confirmación de ese servicio.
// ?cuenta=VLL → solo esa cuenta.  ?enviar=1 → solo manda a SIGMA los envíos aprobados (sin leer el listado).
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import postgres from 'npm:postgres@3.4.4';
import { DOMParser, Element } from 'https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts';

const BASE = 'https://web.multiasistencia.com/w3multi/';
const CUENTAS = [
  { id: 'VLL', nombre: 'Valladolid' },
  { id: 'PAL', nombre: 'Palencia' },
];
const MAX_FICHAS = 50;       // fichas por cuenta y pasada (el resto, en la siguiente)
const REFRESCO_FICHA_H = 20;  // horas: repaso diario de la bitácora
const PARALELO = 3;           // fichas a la vez (sin agobiar al portal)
const FUERA_REFRESCO_H = 2;   // horas: relectura de fichas de servicios fuera de "en curso" aún sin cerrar
const FUERA_DIAS = 30;        // días que se sigue mirando si se cierra un servicio que salió de "en curso"
const MAX_FUERA = 15;         // fichas fuera de curso por cuenta y pasada
const MAX_IVA = 20;           // servicios por cuenta y pasada en los que se comprueba el bloqueo por documento de IVA
const IVA_MARCADO_MIN = 45;   // minutos: se vuelve a mirar un servicio bloqueado (para desbloquearlo cuanto antes)
const IVA_LIBRE_H = 6;        // horas: se vuelve a mirar un servicio no bloqueado
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const dec = new TextDecoder('windows-1252');

// ---------------------------------------------------------------- utilidades
// Algunos textos del portal vienen con tildes rotas ("2ÂºI"): se recomponen si es posible
const utf8 = new TextDecoder('utf-8', { fatal: true });
function arreglar(t: string) {
  if (!/[\u00c2\u00c3][\u0080-\u00ff]/.test(t)) return t;
  return t.replace(/[\u00c2-\u00f4][\u0080-\u00bf]+/g, (m) => {
    try { return utf8.decode(Uint8Array.from([...m].map((c) => c.charCodeAt(0)))); } catch { return m; }
  });
}
const limpio = (t?: string | null) =>
  arreglar((t ?? '').replace(/\u00a0/g, ' ').replace(/[ \t\r]+/g, ' ').replace(/ *\n */g, '\n').trim());
const txt = (e?: Element | null) => limpio(e?.textContent);
const parse = (html: string) => {
  const d = new DOMParser().parseFromString(html, 'text/html');
  if (!d) throw new Error('No se pudo leer la página');
  return d;
};

// Formularios en windows-1252 (el portal no es UTF-8)
const W1252: Record<number, number> = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };
function enc(s: string) {
  let o = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 && /[A-Za-z0-9\-_.*]/.test(ch)) o += ch;
    else if (c === 0x20) o += '+';
    else {
      const b = c < 0x80 ? c : (W1252[c] ?? (c <= 0xFF ? c : 0x3F));
      o += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return o;
}
const codificar = (f: Record<string, string>) => Object.entries(f).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');

// ---------------------------------------------------------------- sesión con el portal
class Sesion {
  cookies = new Map<string, string>();
  private guardar(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  // Si el portal está saturado un momento (502/503/504) se reintenta hasta 2 veces (a los 4 s y a los 12 s).
  // Un 50x significa que el portal no atendió la petición, así que repetirla no duplica nada.
  // Si se corta la conexión o tarda demasiado, solo se reintentan lecturas (GET) y el login/listado,
  // nunca un envío (aceptar ofrecidos, informar citas): podría haberse guardado ya.
  private async conReintento(url: string, method: string, body: string | undefined, headers: Record<string, string>) {
    const esperas = [4000, 12000];
    const repetible = method === 'GET' || /\/(acceso|frepasos_new)\.php/.test(url);
    for (let intento = 0; ; intento++) {
      let res: Response | null = null;
      try {
        res = await fetch(url, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(25000) });
      } catch (err) {
        if (!repetible || intento >= esperas.length) throw err;
      }
      if (res && (![502, 503, 504].includes(res.status) || intento >= esperas.length)) return res;
      if (res) await res.body?.cancel();
      console.warn(`Portal ${res ? res.status : 'sin respuesta'} en ${url.split('?')[0]}: reintento ${intento + 1}`);
      await new Promise((r) => setTimeout(r, esperas[intento]));
    }
  }
  async pedir(ruta: string, form?: Record<string, string>): Promise<string> {
    let url = BASE + ruta;
    let method = form ? 'POST' : 'GET';
    let body: string | undefined = form ? codificar(form) : undefined;
    for (let i = 0; i < 6; i++) {
      const headers: Record<string, string> = { 'User-Agent': UA, Referer: BASE, Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const res = await this.conReintento(url, method, body, headers);
      this.guardar(res);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location')!, url).href;
        method = 'GET'; body = undefined;
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) throw new Error(`El portal respondió ${res.status} en ${ruta.split('?')[0]}`);
      return dec.decode(await res.arrayBuffer());
    }
    throw new Error('Demasiadas redirecciones');
  }
}

const pideClave = (html: string) => /name=["']?clave["'\s>]/i.test(html);

async function entrar(s: Sesion, usuario: string, clave: string) {
  await s.pedir('acceso.php');
  const html = await s.pedir('acceso.php', { usuario, clave });
  if (!pideClave(html) && /frepasos/i.test(html)) return;
  const ini = await s.pedir('inicio.php');
  if (pideClave(ini) || !/frepasos/i.test(ini)) throw new Error('No se pudo entrar: revisa usuario y contraseña de esta cuenta');
}

// ---------------------------------------------------------------- listado "Servicios en curso"
type FilaListado = {
  numero: string; profesional: string; procedencia: string; gremio: string;
  caducidad: number | null; duracion: string; llamadas: number | null; estado: string;
  alerta: 'rojo' | 'amarillo' | 'verde'; marcas: string[]; direccion: string; descripcion: string;
};
type Codigo = { tipo: string; codigo: string; texto: string | null };

const FILTROS_VACIOS = {
  reparacion: '', navid: '', cmbgremio: '', cmbestado: '',
  estado: '', fprocedencia: '', vigencia: '', color: '', tiposervicio: '', gremio: '', furgente: '', fcomarca: '',
};
const PENDIENTES = 'Hay servicios ofrecidos pendientes de confirmación: acéptalos o recházalos en el portal para que se pueda leer el listado';
const num = (s: string) => { const n = parseInt(s.replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; };

function leerListado(html: string) {
  if (pideClave(html)) throw new Error('Sesión caducada en el listado');
  const doc = parse(html);
  const cuerpo = limpio(doc.body?.textContent);
  const total = num((cuerpo.match(/(\d+)\s*Resultados/) || [])[1] ?? '');
  const paginas = num((cuerpo.match(/Página:\s*\d+\s*de\s*(\d+)/) || [])[1] ?? '') ?? 1;
  const filas: FilaListado[] = [];
  for (const nodo of doc.querySelectorAll('td[rowspan="3"]')) {
    const td = nodo as Element;
    const tr = td.parentElement as Element;
    const enlace = tr?.querySelector('a[href*="repasos1.php?reparacion="]');
    if (!enlace) continue;
    const numero = (enlace.getAttribute('href')!.match(/reparacion=(\d+)/) || [])[1];
    if (!numero) continue;
    const c = [...tr.children].filter((x) => x.tagName === 'TD') as Element[];
    const marcas = [...td.querySelectorAll('[title]')].map((e) => (e as Element).getAttribute('title')!.trim()).filter(Boolean);
    const sinMarcas = txt(td);
    if (new RegExp(numero + '\\s*\\*').test(sinMarcas)) marcas.push('Asterisco');
    const cls = td.getAttribute('class') || '';
    const alerta = /rojo/i.test(cls) ? 'rojo' : /amarillo/i.test(cls) ? 'amarillo' : 'verde';
    const sub = (fila: Element | null, et: string) =>
      fila && /^(tr)$/i.test(fila.tagName) && txt(fila.querySelector('td.tcab')).startsWith(et)
        ? txt(fila.querySelector('td.tdet')) : '';
    const f2 = tr.nextElementSibling;
    const f3 = f2?.nextElementSibling ?? null;
    filas.push({
      numero,
      profesional: txt(c[1]), procedencia: txt(c[2]), gremio: txt(c[3]).toUpperCase(),
      caducidad: num(txt(c[4])), duracion: txt(c[5]), llamadas: num(txt(c[6])), estado: txt(c[7]),
      alerta, marcas: [...new Set(marcas)],
      direccion: sub(f2, 'Direcci'), descripcion: sub(f3, 'Descripci'),
    });
  }
  // Códigos de los desplegables de filtros
  const codigos: Codigo[] = [];
  for (const o of doc.querySelectorAll('select[name="estado"] option')) {
    const v = (o as Element).getAttribute('value'); if (!v) continue;
    codigos.push({ tipo: 'estado', codigo: v, texto: txt(o as Element).replace(/^[^-]*-/, '').replace(/-\(\d+\)\s*$/, '').trim() });
  }
  for (const o of doc.querySelectorAll('select[name="gremio"] option')) {
    const v = (o as Element).getAttribute('value'); if (!v) continue;
    const m = txt(o as Element).match(/\(([^)]*)\)/);
    codigos.push({ tipo: 'gremio', codigo: v.toUpperCase(), texto: m ? m[1].trim() : null });
  }
  for (const o of doc.querySelectorAll('select[name="fprocedencia"] option')) {
    const v = (o as Element).getAttribute('value'); if (v) codigos.push({ tipo: 'procedencia', codigo: v, texto: null });
  }
  // El portal obliga a aceptar/rechazar los servicios ofrecidos antes de dejar ver el listado
  if (!filas.length && total === null && /confirmserv/i.test(html)) throw new Error(PENDIENTES);
  // Si no hay filas, guardar un trozo del texto para saber qué mostró el portal
  const ini = Math.max(0, cuerpo.lastIndexOf('Servicios en curso'));
  const aviso = filas.length ? null : cuerpo.slice(ini, ini + 500);
  return { total, paginas, filas, codigos, aviso };
}

async function leerTodoElListado(s: Sesion) {
  // Página 1 sin filtros y con "Recargar datos" (refresh vacío) para tener datos frescos
  const p1 = leerListado(await s.pedir('frepasos_new.php', { ...FILTROS_VACIOS, refresh: '', paginasiguiente: '1', filtrar: 'Filtrar' }));
  const filas = [...p1.filas];
  for (let p = 2; p <= Math.min(p1.paginas, 40); p++) {
    const pg = leerListado(await s.pedir('frepasos_new.php', { ...FILTROS_VACIOS, refresh: '1', paginasiguiente: String(p) }));
    filas.push(...pg.filas);
  }
  const unicos = [...new Map(filas.map((f) => [f.numero, f])).values()];
  return { total: p1.total, paginas: p1.paginas, filas: unicos, leidas: filas.length, codigos: p1.codigos, aviso: p1.aviso };
}

// ---------------------------------------------------------------- Filtro "Caducidad" (vigencia) del listado
// Valores del desplegable: 1 Caducadas/Caducan hoy REDES · 2 No caducadas REDES · 5 Caducadas RESTO
// 6 No caducadas RESTO · 3 Caducadas CLIENTE · 4 No caducadas CLIENTE. Solo se leen las caducadas.
// El filtro queda en la sesión del portal: la página 1 lleva "filtrar" y las siguientes no.
// Devuelve número → grupo, o null si no se pudo leer (entonces no se tocan las marcas).
const VIGENCIA_CADUCADAS: [string, 'redes' | 'resto' | 'cliente'][] = [['1', 'redes'], ['5', 'resto'], ['3', 'cliente']];
async function leerCaducadas(s: Sesion): Promise<Map<string, 'redes' | 'resto' | 'cliente'> | null> {
  try {
    const grupos = new Map<string, 'redes' | 'resto' | 'cliente'>();
    for (const [vigencia, grupo] of VIGENCIA_CADUCADAS) {
      const p1 = leerListado(await s.pedir('frepasos_new.php', { ...FILTROS_VACIOS, vigencia, refresh: '1', paginasiguiente: '1', filtrar: 'Filtrar' }));
      const filas = [...p1.filas];
      for (let p = 2; p <= Math.min(p1.paginas, 20); p++) {
        filas.push(...leerListado(await s.pedir('frepasos_new.php', { ...FILTROS_VACIOS, vigencia, refresh: '1', paginasiguiente: String(p) })).filas);
      }
      if (p1.total !== null && new Set(filas.map((f) => f.numero)).size < p1.total) return null; // lectura incompleta
      for (const f of filas) grupos.set(f.numero, grupo);
    }
    // Dejar la sesión sin filtro
    await s.pedir('frepasos_new.php', { ...FILTROS_VACIOS, refresh: '1', paginasiguiente: '1', filtrar: 'Filtrar' });
    return grupos;
  } catch (err) {
    console.error('caducadas', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------- Gestión repaso → "Pendiente de primer contacto"
// gestRepaso.php es el cuadro de mando del portal; su enlace "Pendiente de primer contacto" lleva a
// muestraservRepaso.php?posicion=servPteContacto&cmbOPER=<profesional> con la lista de servicios.
// Devuelve null si no se pudo leer (entonces no se tocan las marcas que vienen del portal).
async function leerSinContacto(s: Sesion): Promise<Set<string> | null> {
  try {
    const cuadro = await s.pedir('gestRepaso.php');
    if (pideClave(cuadro)) return null;
    const enlace = (cuadro.match(/href="(muestraservRepaso\.php\?posicion=servPteContacto[^"]*)"/i) || [])[1];
    if (!enlace) {
      // Sin enlace: o no hay ninguno (el número sale sin enlace) o el portal cambió
      return /Pendiente de primer contacto/i.test(cuadro) ? new Set() : null;
    }
    const nums = new Set<string>();
    let ruta: string | null = enlace.replace(/&amp;/g, '&');
    for (let p = 0; ruta && p < 10; p++) {
      const html = await s.pedir(ruta);
      if (pideClave(html)) return null;
      for (const m of html.matchAll(/repasos1\.php\?reparacion=(\d+)/g)) nums.add(m[1]);
      const sig = html.match(/<a[^>]+href="([^"]*muestraservRepaso\.php[^"]*)"[^>]*>(?:(?!<\/a>)[\s\S])*siguiente/i);
      const nueva = sig ? sig[1].replace(/&amp;/g, '&') : null;
      ruta = nueva && nueva !== ruta ? nueva : null;
    }
    return nums;
  } catch (err) {
    console.error('gestRepaso', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------- servicios ofrecidos (confirmserv.php)
// El portal no deja ver "Servicios en curso" mientras haya ofrecimientos sin responder.
// Por decisión de la oficina (18/10/2026) el robot los ACEPTA TODOS y avisa a la oficina.
type Ofrecido = { numero: string; gremio: string; fecha: string; hora: string; domicilio: string };

function leerOfrecidos(form: Element): Ofrecido[] {
  const out: Ofrecido[] = [];
  const filas = [...form.querySelectorAll('tr')] as Element[];
  filas.forEach((tr, i) => {
    const c = [...tr.children].map((x) => txt(x as Element));
    if (!/^\d{7,9}$/.test(c[0] || '')) return;
    let domicilio = '';
    for (const sig of filas.slice(i + 1, i + 8)) {
      const d = [...sig.children].map((x) => txt(x as Element));
      if (/^\d{7,9}$/.test(d[0] || '')) break;
      if (d[0] === 'Domicilio' && d[1]) { domicilio = d[1]; break; }
    }
    out.push({ numero: c[0], gremio: (c[1] || '').toUpperCase(), fecha: c[4] || '', hora: c[5] || '', domicilio });
  });
  return out;
}

async function aceptarOfrecidos(s: Sesion): Promise<Ofrecido[]> {
  const html = await s.pedir('confirmserv.php');
  const doc = parse(html);
  const form = doc.querySelector('form[name="confirmserv"]') as Element | null;
  if (!form) throw new Error('No se encontró la página de servicios ofrecidos');
  // Los números que acepta "Aceptar todas" vienen en su propio script
  const nums = [...new Set([...html.matchAll(/cadena_repa\s*\+\s*'\|(\d+)'/g)].map((m) => m[1]))];
  if (!nums.length) throw new Error('Hay ofrecimientos pendientes pero no se encontró ninguno para aceptar');
  const campos: Record<string, string> = {};
  for (const i of form.querySelectorAll('input[type="hidden"]')) {
    const e = i as Element; const n = e.getAttribute('name'); if (n) campos[n] = e.getAttribute('value') ?? '';
  }
  for (const sel of form.querySelectorAll('select')) {
    const e = sel as Element; const n = e.getAttribute('name'); if (!n) continue;
    const opt = (e.querySelector('option[selected]') ?? e.querySelector('option')) as Element | null;
    campos[n] = opt?.getAttribute('value') ?? '';
  }
  campos.todas = nums.join('|'); // lo mismo que hace el botón "Aceptar todas"
  const ofrecidos = leerOfrecidos(form);
  await s.pedir(form.getAttribute('action') || 'confirmserv.php', campos);
  // Comprobar que ya no están pendientes
  const despues = await s.pedir('confirmserv.php');
  const siguen = nums.filter((n) => new RegExp(`processAcepRech\\(\\s*${n}\\s*\\)|'\\|${n}'`).test(despues));
  if (siguen.length) throw new Error(`El portal no aceptó los servicios ofrecidos: ${siguen.join(', ')}`);
  return nums.map((n) => ofrecidos.find((o) => o.numero === n) ?? { numero: n, gremio: '', fecha: '', hora: '', domicilio: '' });
}

// ---------------------------------------------------------------- ficha del servicio
function textoConSaltos(el: Element): string {
  let s = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 3) s += n.textContent;
    else if (n.nodeName === 'BR') s += '\n';
    else if (n.nodeType === 1) s += textoConSaltos(n as Element);
  }
  return s;
}
const MARCA_FECHA = /\((\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2}):(\d{2})\)/;

function leerBitacora(el: Element) {
  const trozos = textoConSaltos(el).split(/\n\s*\n/).map(limpio).filter(Boolean);
  let descripcion = '';
  const entradas: { fecha: string | null; texto: string }[] = [];
  trozos.forEach((t, i) => {
    if (i === 0) {
      const p = t.search(MARCA_FECHA);
      if (p === -1) { descripcion = t; return; }
      descripcion = t.slice(0, p).trim();
      t = t.slice(p);
    }
    const m = t.match(new RegExp('^' + MARCA_FECHA.source));
    entradas.push({
      fecha: m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}` : null,
      texto: m ? t.slice(m[0].length).trim() : t,
    });
  });
  return { descripcion, entradas: entradas.filter((e) => e.texto) };
}

function filasDe(tabla: Element) {
  return ([...tabla.querySelectorAll('tr')] as Element[]).filter((tr) => {
    let p = tr.parentElement;
    while (p && p.tagName !== 'TABLE') p = p.parentElement;
    return p === tabla;
  });
}
const tablaDe = (el: Element) => { let p = el.parentElement; while (p && p.tagName !== 'TABLE') p = p.parentElement; return p; };

// El portal dice "La Reparación No Pertenece Al Profesional" cuando SIGMA nos ha quitado o anulado el servicio.
// OJO: sale el mismo texto si se pide un servicio con la cuenta equivocada (VLL/PAL); por eso solo se pide
// cada ficha con la cuenta del propio servicio y solo se anula si además ha salido de "Servicios en curso".
class NoPertenece extends Error {}
const noPertenece = (html: string) => /no\s+pertenece\s+al\s+profesional/i.test(html);

function leerFicha(html: string) {
  if (pideClave(html)) throw new Error('Sesión caducada en la ficha');
  if (noPertenece(html)) throw new NoPertenece('La Reparación No Pertenece Al Profesional');
  const doc = parse(html);
  const cab = [...doc.querySelectorAll('td.tcab')] as Element[];
  // Cabecera horizontal: títulos en una fila, valores en la siguiente
  const cabecera: Record<string, string> = {};
  const inicio = cab.find((td) => txt(td) === 'Número Reparación');
  if (!inicio) throw new Error('La ficha no tiene el formato esperado');
  const tCab = tablaDe(inicio)!;
  const [fT, fV] = filasDe(tCab);
  const tit = [...fT.children].map((c) => txt(c as Element));
  const val = fV ? [...fV.children].map((c) => txt(c as Element)) : [];
  tit.forEach((t, i) => (cabecera[t] = val[i] ?? ''));
  // Campos verticales: etiqueta (tcab) + valor (tdet)
  const campos: Record<string, string> = {};
  let celdaDescripcion: Element | null = null;
  for (const td of cab) {
    const sig = td.nextElementSibling as Element | null;
    if (!sig || !(sig.getAttribute('class') || '').includes('tdet')) continue;
    const et = txt(td);
    if (!et || et.length > 60) continue;
    if (et.startsWith('Descripción de la Reparación')) celdaDescripcion = sig;
    else if (!(et in campos)) campos[et] = txt(sig);
  }
  // Teléfonos: tablas con títulos Número · Tipo · Desde · Hasta
  const telefonos: { numero: string; tipo: string; desde: string; hasta: string; de: string }[] = [];
  let nTabla = 0;
  for (const td of cab.filter((x) => txt(x) === 'Número')) {
    const t = tablaDe(td)!;
    const fs = filasDe(t);
    const t0 = [...fs[0].children].map((c) => txt(c as Element));
    if (t0[0] !== 'Número') continue;
    const de = nTabla++ === 0 ? 'cliente' : 'perjudicado';
    for (const f of fs.slice(1)) {
      const v = [...f.children].map((c) => txt(c as Element));
      const numero = (v[0] || '').replace(/\s+/g, '');
      if (/\d{6,}/.test(numero)) telefonos.push({ numero, tipo: v[1] || '', desde: v[2] || '', hasta: v[3] || '', de });
    }
  }
  const bit = celdaDescripcion ? leerBitacora(celdaDescripcion) : { descripcion: '', entradas: [] };
  const dp = (cabecera['Distrito Postal'] || '').match(/^(\d{5})\s*-\s*(.*)$/);
  const procTexto = (campos['Procedencia'] || '').replace(/^\d+\s*-\s*/, '').trim();
  // CIERRE: campo "Fecha/Hora Cierre" de la ficha; si viene vacío, anotación "Cierre de Reparación" de la bitácora
  const kCierre = Object.keys(campos).find((k) => /cierre/i.test(k) && /fecha/i.test(k));
  const vCierre = kCierre ? campos[kCierre] : '';
  const anotCierre = bit.entradas.find((e) => /^Cierre de Reparaci/i.test(e.texto));
  const cierre = /\d{2}\/\d{2}\/\d{4}/.test(vCierre || '') ? vCierre : (anotCierre ? `bitácora ${anotCierre.fecha ?? ''}`.trim() : null);
  return {
    numero: cabecera['Número Reparación'],
    poliza: cabecera['Número de Póliza'] || null,
    cliente: cabecera['Nombre Cliente'] || null,
    direccion: cabecera['Dirección'] || null,
    cp: dp ? dp[1] : null,
    poblacion: dp ? dp[2].trim() : (cabecera['Distrito Postal'] || null),
    procedenciaTexto: procTexto || null,
    urgente: /^s[ií]/i.test(campos['Urgente'] || ''),
    estadoTexto: campos['Estado'] || null,
    telefonos,
    descripcion: bit.descripcion,
    bitacora: bit.entradas,
    otros: {
      baremo: cabecera['Baremo'] || null,
      procedencia: campos['Procedencia'] || null,
      forma_pago: campos['Forma de pago'] || null,
      franquicia: campos['Franquicia'] || null,
      fecha_realizacion: campos['Fecha realización'] || null,
      confirmado: campos['Confirmado'] || null,
      apertura: campos['Fecha/Hora Apertura'] || null,
      asignacion: campos['Fecha/Hora Asignación'] || null,
      cierre,
      tramitador: campos['Tramitador'] || null,
      especialidades: campos['Especialidades'] || null,
      herramientas: campos['Herramientas'] || null,
    },
  };
}

// ---------------------------------------------------------------- ENVÍOS A SIGMA (lo que la oficina ha aprobado)
// Repaso: componente moderno del portal que habla con su servicio JSON (review-initial-data / review-update).
// Informar citas: formulario clásico citasPendientes.php.
// Reglas de la oficina (18/10/2026):
//  - En "Informar citas" la fecha/hora de la visita es SIEMPRE la citada, nunca la del informe.
//  - El aviso "este aplazamiento va a generar un SMS al cliente" se confirma SIEMPRE con "Sí".
//  - (19/10/2026) Si el Repaso encuentra una cita anterior sin informar, el robot la informa sola: Visita realizada ·
//    609 Finalizado no requiere nueva cita · comentario «OK» · fecha/hora citadas; y luego hace el Repaso.
const API_REPASO = 'https://mawmods.plataforma-smart.com/me';
const HORAS_REPASO = Array.from({ length: 28 }, (_, i) => String(28800 + i * 1800)); // 08:00 … 21:30
const MOTIVOS_CITA: Record<string, string[]> = { V: ['609', '611', '604', '601'], I: ['706', '707', '708'], C: ['213', '215', '212', '214'] };
type Envio = {
  id: string; parte_id: string; tipo: 'repaso' | 'informar_cita' | 'tramitacion' | 'confirmacion'; motivo_codigo: string | null; motivo_texto: string | null;
  fecha: string | null; hora: string | null; resolucion: string | null; resolucion_motivo: string | null;
  cita_fecha: string | null; cita_hora: string | null; comentario: string; contacto_en?: string | null; confir_variante?: 'rapida' | 'completa' | null; creado_en?: string; parte: { numero_servicio: string; sigma_cuenta: string; estado?: string };
};

// Traduce los códigos de error del servicio de Repaso. Si el código no es conocido (p. ej. "68"),
// se añade el texto que lo acompañe en la respuesta (message, description…) para que la oficina sepa qué pasa.
const CODIGOS_REPASO: Record<string, string> = {
  '68': 'SIGMA pide la fecha y hora en que se contactó con el cliente (servicio sin primer contacto): rellénala en el envío y reintenta',
  APPEND_PENDING_APPOINTMENTS: 'Sigue habiendo una cita anterior sin informar después de informarla: revisa «Informar citas» en el portal',
  TXT_GENERICERROR: 'Error genérico del portal',
  // (20/10/2026) Vistos en envíos reales
  '3057': 'El servicio está cerrado en SIGMA: ya no admite Repaso',
  '4106': 'Hora incorrecta de la siguiente acción (suele ser una hora ya pasada): pon una fecha y hora futuras y reintenta',
  '4108': 'La fecha/hora de contacto con el cliente no puede ser posterior a la actual: corrígela y reintenta',
  '1213': 'SIGMA avisa de que el servicio se ha aplazado tres o más veces (posible penalización si no hay causa justificada): hazlo a mano en el portal',
  'Aplazamiento Pte. Cia./Perito': 'Servicio en «Aplazamiento Pte. Cia./Perito»: SIGMA no deja hacer Repaso hasta que responda la compañía o el perito',
};
// Textos oficiales de los errores del Repaso (los mismos que muestra el portal): GET /translations?module=REVIEW&lang=es → error{código: texto}
let TEXTOS_REPASO: Record<string, string> | null = null;
async function cargarTextosRepaso() {
  if (TEXTOS_REPASO) return;
  try {
    const r = await fetch(`${API_REPASO}/translations?module=REVIEW&lang=es`, {
      signal: AbortSignal.timeout(10000), headers: { Version: '3.0.0', 'User-Agent': UA, Origin: 'https://web.multiasistencia.com' },
    });
    const j = r.ok ? await r.json() : null;
    const err = j?.error ?? j?.data?.error;
    if (err && typeof err === 'object') TEXTOS_REPASO = err as Record<string, string>;
  } catch (err) { console.error('textos Repaso', (err as Error).message); }
}
function traducirCodigos(codes: Record<string, unknown>[] | undefined, extra?: unknown) {
  const lista = (codes || []).filter((x) => x && typeof x === 'object');
  const textoExtra = typeof extra === 'string' && extra.trim() ? extra.trim() : '';
  if (!lista.length) return textoExtra ? `El portal no aceptó el cambio: ${textoExtra}` : 'El portal no aceptó el cambio (sin detalle)';
  return lista.map((x) => {
    const code = String(x.code ?? '');
    if (CODIGOS_REPASO[code]) return CODIGOS_REPASO[code];
    if (TEXTOS_REPASO?.[code]) return `${TEXTOS_REPASO[code]} (código ${code} de SIGMA)`;
    // El portal a veces manda el motivo del bloqueo como texto en «code» (p. ej. el estado del servicio)
    if (/[a-záéíóúñ]{3,}\s/i.test(code)) return `SIGMA no deja hacer el Repaso: ${code}`;
    const textos = Object.entries(x).filter(([k, v]) => k !== 'code' && typeof v === 'string' && v.trim()).map(([, v]) => String(v).trim());
    const detalle = textos.length ? textos.join(' / ') : (textoExtra || JSON.stringify(x).slice(0, 300));
    return `Código ${code || '?'} del portal: ${detalle}`;
  }).join(' · ');
}
const hoyMadrid = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
// Minuto actual en Madrid con el mismo formato que la bitácora ("aaaa-mm-dd hh:mm"), un minuto antes por margen
const minutoMadrid = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .format(new Date(Date.now() - 60000)).replace('T', ' ');
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Fallo del portal en el que no se sabe si el cambio se guardó
class Dudoso extends Error {}
// El portal bloquea el Repaso porque el documento de IVA está pendiente de validar por SIGMA
class IvaPendiente extends Error {}
// Informar citas: el portal no tiene ninguna cita pendiente (ya informada o retirada en SIGMA) → no es un error
class SinCitaPendiente extends Error {}
// Repaso con un motivo de aplazamiento en un siniestro sin confirmar: SIGMA lo rechaza (código 1212) → no es un error,
// se descarta solo (decisión del usuario 27/10/2026). El servicio conserva en SIGMA la cita que ya tenía.
class SinConfirmar extends Error {}
const SIN_CONFIRMAR = 'Descartado solo: SIGMA no deja aplazar un siniestro sin confirmar (código 1212). En SIGMA sigue la cita que ya tenía el servicio. Si hay que aplazar: primero la Confirmación (sale en esta bandeja tras el informe del operario) y después un Repaso nuevo.';
// Repaso en un servicio en estado 6 o 16: SIGMA lo rechaza con el motivo como texto en «code» → no es un error, se descarta
// solo (decisión del usuario 04/11/2026). No se deja en espera: un Repaso no debe salir días después de aprobarlo.
class BloqueadoPorEstado extends Error {}
const BLOQUEOS_ESTADO_REPASO: [RegExp, string][] = [
  [/aplazamiento\s+pte\.?\s+cia/i, '«Aplazamiento Pte. Cia./Perito»'],
  [/confirmaci[oó]n\s+o\s+presupuesto\s+pendiente\s+de\s+tramitar/i, '«Confirmación o Presupuesto pendiente de tramitar»'],
];
function bloqueoEstadoRepaso(codes: { code?: unknown }[] | undefined): string | null {
  for (const x of codes || []) {
    const b = BLOQUEOS_ESTADO_REPASO.find(([re]) => re.test(String(x?.code ?? '')));
    if (b) return `Descartado solo: SIGMA no admite Repaso mientras el servicio esté en ${b[1]}. No se ha enviado el Repaso; cuando se desbloquee, hay que pedir uno nuevo.`;
  }
  return null;
}
const SIN_CITA = 'Descartado solo: el portal no tiene ninguna cita pendiente de informar en este servicio (ya informada o retirada en SIGMA). No hay nada que enviar.';
const IVA_PENDIENTE = /documento\s+de\s+iva\s+pendiente/i;
const BLOQUEO_IVA = 'Bloqueado por SIGMA: documento de IVA pendiente de validar. No se ha enviado el Repaso; usa «Enviar a tramitación» y vuelve a intentarlo cuando SIGMA lo valide.';

// Pase de sesión del componente Repaso (ut): es el mismo para todos los servicios de la cuenta (JWT del usuario)
async function paseRepaso(s: Sesion, n: string) {
  const html = await s.pedir(`fechaccion.php?reparacion=${n}&modo=0`);
  return (html.match(/<multiasistencia-repaso[^>]*\sut="([^"]+)"/i) || [])[1] || null;
}
// Solo lectura: ¿deja el portal abrir el Repaso? 'iva' = bloqueado por el documento de IVA · 'ok' · 'otro' (otro motivo)
// null = no se pudo saber (fallo del portal)
async function estadoRepaso(ut: string, n: string): Promise<'iva' | 'ok' | 'otro' | null> {
  try {
    const r = await fetch(`${API_REPASO}/review-initial-data`, {
      method: 'POST', signal: AbortSignal.timeout(20000), body: JSON.stringify({ reparation: n }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ut}`, Version: '3.0.0', 'User-Agent': UA, Origin: 'https://web.multiasistencia.com', Referer: BASE + 'fechaccion.php' },
    });
    if (!r.ok) { await r.body?.cancel(); return null; }
    const j = await r.json();
    if (j?.success) return 'ok';
    return IVA_PENDIENTE.test(JSON.stringify(j?.metadata ?? j ?? '')) ? 'iva' : 'otro';
  } catch { return null; }
}

async function enviarRepaso(s: Sesion, e: Envio): Promise<string> {
  const n = e.parte.numero_servicio;
  if (!e.motivo_codigo) throw new Error('Falta el motivo');
  if (!e.fecha) throw new Error('Falta la fecha siguiente acción');
  if (!e.comentario.trim()) throw new Error('Falta el comentario');
  const ut = await paseRepaso(s, n);
  if (!ut) throw new Error('No se pudo abrir la pestaña Repaso de este servicio');
  await cargarTextosRepaso();
  // Un 50x, un corte o un tiempo agotado en review-update es DUDOSO: el portal pudo guardar el cambio
  // aunque no contestara. Se marca como Dudoso para comprobarlo en la ficha antes de repetir nada.
  const api = async (ruta: string, cuerpo: unknown) => {
    let r: Response;
    try {
      r = await fetch(`${API_REPASO}/${ruta}`, {
        method: 'POST', signal: AbortSignal.timeout(30000), body: JSON.stringify(cuerpo),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ut}`, Version: '3.0.0', 'User-Agent': UA, Origin: 'https://web.multiasistencia.com', Referer: BASE + 'fechaccion.php' },
      });
    } catch (err) {
      throw new Dudoso(`sin respuesta del servicio de Repaso (${(err as Error).name === 'TimeoutError' ? 'tiempo agotado' : 'conexión cortada'})`);
    }
    if (r.status >= 500) { await r.body?.cancel(); throw new Dudoso(`el servicio de Repaso respondió ${r.status}`); }
    if (r.status === 401 || r.status === 404) throw new Error(`El servicio de Repaso respondió ${r.status}`);
    return await r.json();
  };
  // review-initial-data solo lee: si el portal está saturado se repite una vez sin riesgo
  let ini;
  try { ini = await api('review-initial-data', { reparation: n }); }
  catch (err) {
    if (!(err instanceof Dudoso)) throw err;
    await esperar(5000);
    try { ini = await api('review-initial-data', { reparation: n }); }
    catch (err2) { throw new Error(`Portal SIGMA saturado: ${(err2 as Error).message}. No se envió nada; reintenta en un rato`); }
  }
  // Cita anterior sin informar (APPEND_PENDING_APPOINTMENTS): regla de la oficina (19/10/2026) → el robot la informa
  // sola, genérica: Visita realizada · 609 Finalizado no requiere nueva cita · comentario «OK» · fecha/hora CITADAS.
  // Después vuelve a abrir el Repaso. Forma parte del Repaso aprobado por la oficina.
  const citasInformadas: string[] = [];
  const pideCita = (r: { metadata?: { errorCodes?: { code?: string }[] } } | null) =>
    !r?.success && (r?.metadata?.errorCodes || []).some((x) => String(x?.code) === 'APPEND_PENDING_APPOINTMENTS');
  for (let vuelta = 0; vuelta < 3 && pideCita(ini); vuelta++) {
    try {
      const hechas = await informarCitasPendientes(s, n, CITA_GENERICA.resolucion, CITA_GENERICA.motivo, CITA_GENERICA.comentario, null, null, true);
      citasInformadas.push(...hechas);
    } catch (err) {
      throw new Error(`Hay una cita anterior sin informar y no se pudo informar sola: ${(err as Error).message}${citasInformadas.length ? ` (ya informadas: ${citasInformadas.join('; ')})` : ''}`);
    }
    try { ini = await api('review-initial-data', { reparation: n }); }
    catch (err) { throw new Error(`Cita informada (${citasInformadas.join('; ')}), pero el portal no respondió al abrir el Repaso: ${(err as Error).message}. Reintenta el Repaso en un rato`); }
  }
  const prefijoCitas = citasInformadas.length ? `Cita anterior informada (Visita realizada · Finalizado · «OK»): ${citasInformadas.join('; ')} · ` : '';
  if (!ini?.success) {
    console.error('review-initial-data', n, JSON.stringify(ini?.metadata ?? ini).slice(0, 1500));
    if (IVA_PENDIENTE.test(JSON.stringify(ini?.metadata?.errorCodes ?? ini?.metadata ?? ini ?? ''))) throw new IvaPendiente('Documento de IVA pendiente de validar');
    const bloqueo = bloqueoEstadoRepaso(ini?.metadata?.errorCodes);
    if (bloqueo) throw new BloqueadoPorEstado(prefijoCitas + bloqueo);
    throw new Error(prefijoCitas + 'Al abrir Repaso: ' + traducirCodigos(ini?.metadata?.errorCodes, ini?.metadata?.message ?? ini?.message));
  }
  try {
    return prefijoCitas + await guardarRepaso(s, e, n, ini, api);
  } catch (err) {
    if (err instanceof SinConfirmar) throw new SinConfirmar(prefijoCitas + (err as Error).message);
    if (err instanceof BloqueadoPorEstado) throw new BloqueadoPorEstado(prefijoCitas + (err as Error).message);
    if (prefijoCitas && !(err instanceof IvaPendiente)) throw new Error(prefijoCitas + (err as Error).message);
    throw err;
  }
}

// Segunda parte del Repaso (ya abierto en el portal): valida el envío y lo guarda con review-update
// deno-lint-ignore no-explicit-any
async function guardarRepaso(s: Sesion, e: Envio, n: string, ini: any, api: (ruta: string, cuerpo: unknown) => Promise<any>): Promise<string> {
  const d = ini.data;
  if (!d.availabilityPermission) throw new Error('El portal pide elegir hueco de agenda para este servicio: hazlo a mano en el portal');
  if (d.swConforme) throw new Error('El portal pide una conformidad adicional: hazlo a mano en el portal');
  const motivo = (d.reasonInfo?.reasonComboList || []).find((m: { value: string }) => String(m.value) === String(e.motivo_codigo));
  if (!motivo) throw new Error(`El motivo "${e.motivo_texto || e.motivo_codigo}" no está disponible ahora para este servicio`);
  if (motivo.sub?.length) throw new Error(`El motivo "${motivo.label}" pide un submotivo: hazlo a mano en el portal`);
  const max = Number((String(motivo.label).match(/\[(\d+)\]/) || [])[1] ?? NaN);
  const hoy = hoyMadrid();
  const dias = Math.round((Date.parse(e.fecha!) - Date.parse(hoy)) / 86400000);
  if (dias < 0) throw new Error('La fecha ya ha pasado');
  if (dias === 0 && e.hora && e.hora.slice(0, 5) <= minutoMadrid().slice(11, 16)) throw new Error('La hora de la siguiente acción ya ha pasado: pon una fecha y hora futuras y reintenta');
  if (Number.isFinite(max) && dias > max) throw new Error(`Para "${motivo.label}" la fecha no puede pasar de ${max} días desde hoy`);
  let hourRaw = '';
  if (e.hora) {
    const [h, m] = e.hora.split(':').map(Number);
    hourRaw = String(h * 3600 + m * 60);
    if (!HORAS_REPASO.includes(hourRaw)) throw new Error('La hora del Repaso debe ser en punto o y media, entre 08:00 y 21:30');
  }
  const [a, mes, dia] = e.fecha!.split('-');
  // Servicio sin primer contacto (estado 15): SIGMA exige «Fecha en la que contactó con el cliente» (si falta → código 68)
  let contacto: Record<string, string> | null = null;
  if (d.dates?.clientContact) {
    if (!e.contacto_en) throw new Error('SIGMA pide la fecha y hora en que se contactó con el cliente (servicio sin primer contacto): rellénala en el envío y reintenta');
    const cuando = new Date(e.contacto_en);
    if (cuando.getTime() > Date.now()) throw new Error(CODIGOS_REPASO['4108']);
    const pz = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(cuando).map((x) => [x.type, x.value]));
    const hh = pz.hour.padStart(2, '0'), mi = pz.minute.padStart(2, '0');
    if (Number(hh) < 8) throw new Error('La hora de contacto con el cliente debe estar entre las 08:00 y las 24:00');
    contacto = { day: String(Number(pz.day)), month: String(Number(pz.month)), year: pz.year, hourRaw: String(3600 * Number(hh) + 60 * Number(mi)), hour: hh, minute: mi };
  }
  const cmd: Record<string, unknown> = {
    reparation: n, controlAvailability: 1, controlDuration: 1,
    reviewReason: String(e.motivo_codigo), comment: e.comentario.trim(),
    dates: { actionDate: { day: String(Number(dia)), month: String(Number(mes)), year: a, hourRaw }, exceededDate: d.dates?.exceededDate ?? null, ...(contacto ? { clientContactDate: contacto } : {}) },
  };
  if (d.heater?.enabled && d.heater.ageHeater) cmd.heater = { ageHeater: d.heater.ageHeater };
  // Secuencia del portal (probada a mano el 18/10/2026, servicio 29385460):
  //  1) review-update → AVISO_SMS ("va a generar un SMS al cliente")         → siempre "Sí" (smsResponse:"si")
  //  2) si la agenda no tiene hueco para esa fecha/hora, responde success:true SIN código y con la lista
  //     de huecos (dateGapSelectList): "No existe disponibilidad…" con a) mantener / b) siguiente hueco libre
  //     → siempre a) "No importa, quiero mantener la fecha / hora introducida" (hourRadioButton = la hora elegida)
  //  3) vuelve a pedir el aviso de SMS → siempre "Sí"
  //  4) APLAZAMOK = guardado.
  const nombreMotivo = String(motivo.label).replace(/\s*\[\d+\]/, '').trim();
  const resumen = (extra = '') => `Repaso guardado: ${nombreMotivo} ${dia}/${mes}/${a}${e.hora ? ' ' + e.hora.slice(0, 5) : ''}${contacto ? ` · contacto con el cliente ${contacto.day}/${contacto.month} ${contacto.hour}:${contacto.minute}` : ''}${extra}`;
  const inicio = minutoMadrid(); // para reconocer en la bitácora la anotación de este envío
  // ¿Ya está en SIGMA? Busca en la bitácora de la ficha una anotación de este motivo y fecha/hora hecha desde el inicio del envío
  const yaGuardado = async () => {
    const f = leerFicha(await s.pedir(`repasos1.php?reparacion=${n}`));
    const marca = `(${dia}/${mes}/${a}${e.hora ? ' - ' + e.hora.slice(0, 5) : ''}`;
    return f.bitacora.some((b) => b.fecha && b.fecha >= inicio && b.texto.startsWith(nombreMotivo) && b.texto.includes(marca));
  };
  let sms = false, mantenida = false, dudas = 0;
  let enviar: Record<string, unknown> = cmd;
  for (let paso = 0; paso < 8; paso++) {
    let res;
    try {
      res = await api('review-update', enviar);
    } catch (err) {
      if (!(err instanceof Dudoso)) throw err;
      // Respuesta dudosa: comprobar en la ficha del portal antes de repetir (evita citas y SMS duplicados)
      dudas++;
      await esperar(8000);
      let guardado: boolean;
      try { guardado = await yaGuardado(); }
      catch { throw new Error(`Portal SIGMA saturado (${err.message}) y no se pudo comprobar si se guardó: mira la ficha en el portal antes de reintentar`); }
      if (guardado) return resumen(' (comprobado en la ficha tras un fallo del portal)');
      if (dudas > 1) throw new Error(`Portal SIGMA saturado dos veces (${err.message}). Comprobado: no se guardó nada; reintenta en un rato`);
      sms = false; mantenida = false; enviar = cmd; // no se guardó: se repite desde el principio una vez
      continue;
    }
    const code = res?.metadata?.errorCodes?.[0]?.code;
    if (code === 'APLAZAMOK') {
      return resumen(`${mantenida ? ' (fecha/hora mantenida aunque la agenda no tenía hueco)' : ''}${sms ? ' (SMS al cliente confirmado)' : ''}${dudas ? ' (reintentado tras un fallo del portal)' : ''}`);
    }
    if (code === 'AVISO_SMS') { // aviso genérico de SMS al cliente: siempre "Sí"
      if (enviar.smsResponse) throw new Error('El portal repitió el aviso de SMS tras contestar "Sí"');
      sms = true;
      enviar = { ...enviar, smsResponse: 'si' };
      continue;
    }
    if (res?.success && !code && res.data?.dates) { // pantalla de huecos de agenda
      const nd = res.data;
      if (nd.requestMultiGap) throw new Error('El portal pide confirmar una cita de varios huecos (multihueco): hazlo a mano en el portal');
      if (mantenida) throw new Error('El portal volvió a pedir hueco de agenda tras elegir "mantener la fecha/hora"');
      if (!nd.allowMaintainAppointmentGap) throw new Error('No hay hueco en la agenda para esa fecha/hora y el portal no deja mantenerla: elige otro hueco en el portal');
      if (!hourRaw) throw new Error('El portal pide hora para mantener la cita y el envío no tiene hora');
      mantenida = true;
      // Igual que la opción a) del portal; el formulario se rehace, así que el aviso de SMS se pregunta otra vez
      enviar = {
        ...cmd, hourRadioButton: hourRaw,
        dates: { actionDate: { day: String(Number(dia)), month: String(Number(mes)), year: a, hourRaw, date: `${dia}/${mes}/${a}` }, exceededDate: nd.dates.exceededDate ?? null, ...(contacto ? { clientContactDate: contacto } : {}) },
      };
      continue;
    }
    console.error('review-update', n, JSON.stringify(res?.metadata ?? res).slice(0, 1500));
    if ((res?.metadata?.errorCodes || []).some((x: { code?: unknown }) => String(x?.code) === '1212')) throw new SinConfirmar(SIN_CONFIRMAR);
    const bloqueo = bloqueoEstadoRepaso(res?.metadata?.errorCodes);
    if (bloqueo) throw new BloqueadoPorEstado(bloqueo);
    throw new Error('Al guardar Repaso: ' + traducirCodigos(res?.metadata?.errorCodes, res?.metadata?.message ?? res?.message));
  }
  throw new Error('El portal pidió demasiados pasos seguidos: revisa el servicio en el portal');
}

// Cita genérica que el robot informa solo antes de un Repaso (decisión del usuario 19/10/2026; desde 21/10 también citas futuras)
const CITA_GENERICA = { resolucion: 'V', motivo: '609', comentario: 'OK' };
const RES_CITA: Record<string, string> = { V: 'Visita realizada', I: 'Visita cancelada', C: 'Cita cancelada' };

// Informa en citasPendientes.php una cita pendiente (o todas si `todas`). Devuelve una línea por cita informada.
// La fecha/hora de la visita es SIEMPRE la citada que muestra el portal (si no se ve, la planificada en el envío).
async function informarCitasPendientes(s: Sesion, n: string, resolucion: string, motivo: string, comentario: string,
  citaFecha: string | null, citaHora: string | null, todas: boolean): Promise<string[]> {
  const leer = async () => {
    const html = await s.pedir(`citasPendientes.php?reparacion=${n}&modo=0`);
    const doc = parse(html);
    const filas = ([...doc.querySelectorAll('tr[onclick*="seleccionarCita"]')] as Element[]).map((tr) => {
      const t = txt(tr);
      const m = t.match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s*-\s*(\d{2}):(\d{2}))?/);
      return { id: tr.getAttribute('id') || '', primera: tr.getAttribute('primeravisita') === '1', fecha: m ? `${m[3]}-${m[2]}-${m[1]}` : null, hora: m && m[4] ? `${m[4]}:${m[5]}` : null };
    }).filter((f) => f.id);
    return { doc, filas };
  };
  const hechas: string[] = [];
  let actual = await leer();
  if (!actual.filas.length) throw new SinCitaPendiente('El portal no tiene ninguna cita pendiente de informar en este servicio');
  for (let i = 0; i < 5 && actual.filas.length; i++) {
    const { doc } = actual;
    // En modo automático (todas) se informan TODAS las pendientes, pasadas o futuras (decisión del usuario 21/10/2026:
    // al hacer un Repaso, la cita anterior se da siempre por «Visita realizada · Finalizado · OK» con su fecha/hora citada)
    const filas = actual.filas;
    const fila = (!todas && citaFecha ? filas.find((f) => f.fecha === citaFecha) : null) ?? filas[0];
    const form = doc.querySelector('form[name="datos_cita"]') as Element | null;
    if (!form) throw new Error('No se encontró el formulario de Informar citas');
    const oculto = (nombre: string) => (form.querySelector(`input[name="${nombre}"]`) as Element | null)?.getAttribute('value') ?? '';
    const campos: Record<string, string> = {
      idCita: fila.id, reparacion: oculto('reparacion') || n, desde: oculto('desde'), UpdateFrm: '1',
      resolucion, motivo, comentario,
    };
    const fecha = fila.fecha ?? citaFecha;
    const hora = fila.hora ?? citaHora?.slice(0, 5) ?? null;
    if (resolucion === 'V' && fila.primera) {
      if (!fecha || !hora) throw new Error('No se sabe la fecha y hora citadas de la visita');
      const [a, mes, dia] = fecha.split('-');
      const [hh, mm] = hora.split(':');
      if (Number(hh) < 7 || Number(hh) > 22) throw new Error('La hora citada está fuera del rango que admite el portal (07–22 h)');
      Object.assign(campos, { dia: String(Number(dia)), mes: String(Number(mes)), ano: a, hora: hh.padStart(2, '0'), minutos: mm.padStart(2, '0') });
    }
    await s.pedir(form.getAttribute('action') || 'citasPendientes.php', campos);
    actual = await leer();
    if (actual.filas.some((f) => f.id === fila.id)) throw new Error('El portal no dio por informada la cita (sigue pendiente)');
    const [a, mes, dia] = (fecha ?? '').split('-');
    hechas.push(`${RES_CITA[resolucion]}${fecha ? ` cita ${dia}/${mes}/${a}${hora ? ' ' + hora : ''}` : ''}`);
    if (!todas) break;
  }
  return hechas;
}

async function enviarInformarCita(s: Sesion, e: Envio): Promise<string> {
  const n = e.parte.numero_servicio;
  if (!e.resolucion || !e.resolucion_motivo) throw new Error('Falta la resolución o el motivo');
  if (!MOTIVOS_CITA[e.resolucion]?.includes(e.resolucion_motivo)) throw new Error('El motivo no corresponde a la resolución elegida');
  if (!e.comentario.trim()) throw new Error('Falta el comentario');
  const hechas = await informarCitasPendientes(s, n, e.resolucion, e.resolucion_motivo, e.comentario.trim(), e.cita_fecha, e.cita_hora, false);
  return `Cita informada: ${hechas.join('; ')}`;
}

// Mensaje a tramitación (pestaña "Su Gestor/Tramitador", sugestor.php). Lo pide la oficina con el botón
// «Enviar a tramitación» (p. ej. cuando el Repaso está bloqueado por el documento de IVA).
// Formulario formmensaje: reparacion, motivo (1 Consulta/comentario · 3 Ausencias/problemas citas · 4 Otros ·
// 5 Respuesta a control de presupuestos) y mensaje. Es un envío: no se reintenta si se corta la conexión.
const MOTIVOS_TRAMITACION: Record<string, string> = { '1': 'Consulta/comentario servicio abierto o cerrado recientemente', '3': 'Ausencias/problemas atención citas', '4': 'Otros', '5': 'Respuesta a control de presupuestos' };
async function enviarTramitacion(s: Sesion, e: Envio): Promise<string> {
  const n = e.parte.numero_servicio;
  const motivo = MOTIVOS_TRAMITACION[String(e.motivo_codigo)] ? String(e.motivo_codigo) : '4';
  const mensaje = e.comentario.trim();
  if (!mensaje) throw new Error('Falta el texto del mensaje');
  const pagina = await s.pedir(`sugestor.php?reparacion=${n}&modo=0&navid=`);
  if (pideClave(pagina) || /C[óo]digo del error/i.test(pagina)) throw new Error('No se pudo abrir la pestaña Su Gestor/Tramitador de este servicio');
  if (!/name=["']?formmensaje/i.test(pagina)) throw new Error('La pestaña Su Gestor/Tramitador no tiene el formulario de mensajes');
  const res = await s.pedir('sugestor.php', { reparacion: n, motivo, mensaje });
  const texto = limpio(parse(res).body?.textContent);
  console.log('mensaje tramitación', n, texto.slice(0, 800));
  if (pideClave(res) || /C[óo]digo del error/i.test(res)) throw new Error('El portal devolvió un error al enviar el mensaje: mira la pestaña Su Gestor/Tramitador antes de reintentar');
  return `Mensaje enviado a tramitación (${MOTIVOS_TRAMITACION[motivo]}): «${mensaje}»`;
}

// ---------------------------------------------------------------- Confirmación (pestaña «Confirmación», confirval.php)
// Componente <multiasistencia-fnol> con el mismo servicio JSON y el mismo pase (ut) que el Repaso. Regla del usuario
// (23/10/2026): solo se confirma cuando llega el informe del operario y lo aprueba la oficina.
//  · POST fnol-initial-data {reparation}: success → variante COMPLETA (clasificador de daños + formulario);
//    data.confirmed === '1' → ya confirmado. Si falla con el código «FASTTRACK» → variante RÁPIDA.
//  · POST fasttrack-initial-data {reparation} → causa, garantía, descripción, siniestro; contactClient / firstVisit = '1'
//    si SIGMA pide la fecha de contacto con el cliente / de primera visita.
//  · POST fasttrack-confirm {infoConfirmation:'', reparation, clientContactDate?, firstVisitDate?}
//    (fechas como en el Repaso: día y mes sin cero, hourRaw en segundos, hora y minuto con dos cifras). Éxito = CONFIRVALREDAZPOK.
//  · La variante completa (clasificador externo de SIGMA, decide la cobertura) la hace la oficina en el portal.
const MAX_CONFIR = 8; // informes por cuenta y pasada
const CONFIR_OK = 'CONFIRVALREDAZPOK';
let TEXTOS_FNOL: Record<string, string> | null = null;
async function cargarTextosFnol() {
  if (TEXTOS_FNOL) return;
  try {
    const r = await fetch(`${API_REPASO}/translations?module=FNOL&lang=es`, {
      signal: AbortSignal.timeout(10000), headers: { Version: '3.0.0', 'User-Agent': UA, Origin: 'https://web.multiasistencia.com' },
    });
    const j = r.ok ? await r.json() : null;
    const err = j?.error ?? j?.data?.error;
    if (err && typeof err === 'object') TEXTOS_FNOL = err as Record<string, string>;
  } catch (err) { console.error('textos Confirmación', (err as Error).message); }
}
function textoFnol(codes: { code?: unknown; append?: unknown }[] | undefined) {
  const lista = (codes || []).flatMap((x) => (Array.isArray(x?.code) ? x.code : [x?.code])).filter(Boolean).map(String);
  if (!lista.length) return 'El portal no aceptó la confirmación (sin detalle)';
  return lista.map((c) => TEXTOS_FNOL?.[c] ? `${String(TEXTOS_FNOL[c]).replace(/\{\{STRING\}\}\.?/g, '').trim()} (código ${c} de SIGMA)` : `Código ${c} de SIGMA`).join(' · ');
}
async function paseConfirmacion(s: Sesion, n: string) {
  const html = await s.pedir(`confirval.php?reparacion=${n}&modo=0`);
  return (html.match(/<multiasistencia-fnol[^>]*\sut="([^"]+)"/i) || [])[1] || null;
}
// deno-lint-ignore no-explicit-any
async function apiFnol(ut: string, ruta: string, cuerpo: unknown, envio = false): Promise<any> {
  let r: Response;
  try {
    r = await fetch(`${API_REPASO}/${ruta}`, {
      method: 'POST', signal: AbortSignal.timeout(envio ? 30000 : 20000), body: JSON.stringify(cuerpo),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ut}`, Version: '3.0.0', 'User-Agent': UA, Origin: 'https://web.multiasistencia.com', Referer: BASE + 'confirval.php' },
    });
  } catch (err) {
    const que = (err as Error).name === 'TimeoutError' ? 'tiempo agotado' : 'conexión cortada';
    if (envio) throw new Dudoso(`sin respuesta del servicio de Confirmación (${que})`);
    throw new Error(`Sin respuesta del servicio de Confirmación (${que})`);
  }
  if (r.status >= 500) { await r.body?.cancel(); if (envio) throw new Dudoso(`el servicio de Confirmación respondió ${r.status}`); throw new Error(`El servicio de Confirmación respondió ${r.status}`); }
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error(`Respuesta rara del servicio de Confirmación (${r.status})`); }
}
type EstadoConfir = { estado: 'confirmado' } | { estado: 'rapida' | 'completa'; datos: Record<string, unknown> } | { estado: 'no_aplica'; motivo: string };
// Solo lectura: ¿está confirmado el servicio en SIGMA? Si no, de qué variante es y qué muestra el portal
async function estadoConfirmacion(ut: string, n: string): Promise<EstadoConfir> {
  const ini = await apiFnol(ut, 'fnol-initial-data', { reparation: n });
  const d = ini?.data;
  const codigos = (ini?.metadata?.errorCodes || []) as { code?: unknown }[];
  if (ini?.success && d) {
    if (String(d.confirmed) === '1') return { estado: 'confirmado' };
    const c = d.confirmationData || {};
    // Datos del siniestro más completos (garantía, descripción, nº de siniestro): solo lectura, si el portal los da
    let fc: Record<string, unknown> = {}, sn: Record<string, unknown> = {};
    try {
      const f = await apiFnol(ut, 'fasttrack-initial-data', { reparation: n });
      if (f?.success && f.data) { fc = f.data.confirmationData || {}; sn = f.data.sinisterData || {}; }
    } catch { /* sin datos extra */ }
    return { estado: 'completa', datos: {
      grupo_causa: fc.gCause ?? sn.causesGroup ?? null, causa: c.cause ?? fc.cause ?? null, garantia: c.warranty || fc.warranty || null,
      descripcion: c.description || fc.description || null, siniestro: sn.sinisterNumber ?? null, ocurrencia: sn.dateOccurrence ?? null,
      limite: d.limitValue ?? c.limitValue ?? null,
      pide_contacto: String(d.clientContact) === '1', pide_primera_visita: String(d.firstVisit) === '1', leido_en: new Date().toISOString(),
    } };
  }
  if (codigos.some((x) => String(x?.code) === 'FASTTRACK')) {
    const f = await apiFnol(ut, 'fasttrack-initial-data', { reparation: n });
    if (!f?.success || !f?.data) return { estado: 'no_aplica', motivo: `fasttrack-initial-data: ${textoFnol(f?.metadata?.errorCodes)}` };
    const fd = f.data, c = fd.confirmationData || {}, sn = fd.sinisterData || {};
    return { estado: 'rapida', datos: {
      grupo_causa: c.gCause ?? sn.causesGroup ?? null, causa: c.cause ?? null, garantia: c.warranty || null, descripcion: c.description || null,
      siniestro: sn.sinisterNumber ?? null, ocurrencia: sn.dateOccurrence ?? null, aviso: fd.infoMessage || null,
      pide_contacto: String(fd.contactClient) === '1', pide_primera_visita: String(fd.firstVisit) === '1', leido_en: new Date().toISOString(),
    } };
  }
  return { estado: 'no_aplica', motivo: textoFnol(codigos) };
}
// Fecha de SIGMA a partir de "aaaa-mm-dd" + "hh:mm"
function fechaSigma(fecha: string, hora: string) {
  const [a, m, d] = fecha.split('-');
  const [hh, mm] = hora.slice(0, 5).split(':');
  return { day: String(Number(d)), month: String(Number(m)), year: a, hourRaw: String(3600 * Number(hh) + 60 * Number(mm)), hour: hh.padStart(2, '0'), minute: mm.padStart(2, '0') };
}
// Fecha/hora de Madrid "aaaa-mm-dd hh:mm" de un timestamptz
const madrid = (iso: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace('T', ' ');

async function enviarConfirmacion(s: Sesion, e: Envio): Promise<string> {
  const n = e.parte.numero_servicio;
  const ut = await paseConfirmacion(s, n);
  if (!ut) throw new Error('No se pudo abrir la pestaña Confirmación de este servicio');
  await cargarTextosFnol();
  const est = await estadoConfirmacion(ut, n);
  if (est.estado === 'confirmado') return e.confir_variante === 'completa' ? 'Confirmación hecha en el portal (comprobado)' : 'El servicio ya estaba confirmado en SIGMA: no se ha enviado nada';
  if (est.estado === 'no_aplica') throw new Error(`El portal no deja confirmar ahora: ${est.motivo}`);
  if (est.estado === 'completa') throw new Error('Confirmación completa: aún no está hecha en el portal. Hazla en la pestaña Confirmación y vuelve a aprobar');
  // Variante rápida
  const cuerpo: Record<string, unknown> = { infoConfirmation: '', reparation: n };
  const ahora = minutoMadrid();
  if (est.datos.pide_contacto) {
    if (!e.contacto_en) throw new Error('SIGMA pide la fecha y hora de contacto con el cliente: rellénala y vuelve a aprobar');
    const cc = madrid(e.contacto_en);
    if (cc > ahora) throw new Error('La fecha de contacto con el cliente no puede ser posterior a ahora');
    cuerpo.clientContactDate = fechaSigma(cc.slice(0, 10), cc.slice(11, 16));
  }
  if (est.datos.pide_primera_visita) {
    if (!e.cita_fecha || !e.cita_hora) throw new Error('SIGMA pide la fecha y hora de la primera visita: rellénala y vuelve a aprobar');
    const pv = `${e.cita_fecha} ${e.cita_hora.slice(0, 5)}`;
    if (pv > ahora) throw new Error('La fecha de primera visita no puede ser posterior a ahora');
    cuerpo.firstVisitDate = fechaSigma(e.cita_fecha, e.cita_hora);
  }
  const res = await apiFnol(ut, 'fasttrack-confirm', cuerpo, true);
  const codigos = (res?.metadata?.errorCodes || []) as { code?: unknown }[];
  if (codigos.some((x) => String(x?.code) === CONFIR_OK)) {
    const extra = [cuerpo.clientContactDate ? `contacto ${madrid(e.contacto_en!).split(' ').map((x, i) => i ? x : x.split('-').reverse().join('/')).join(' ')}` : '',
      cuerpo.firstVisitDate ? `primera visita ${e.cita_fecha!.split('-').reverse().join('/')} ${e.cita_hora!.slice(0, 5)}` : ''].filter(Boolean).join(' · ');
    return `Siniestro confirmado en SIGMA${extra ? ` (${extra})` : ''}`;
  }
  console.error('fasttrack-confirm', n, JSON.stringify(res).slice(0, 1500));
  throw new Error('Al confirmar: ' + textoFnol(codigos));
}

// Informes nuevos de servicios SIGMA: si el servicio está sin confirmar, borrador 'confirmacion' para la oficina.
// Solo lectura en el portal. Un informe se mira una vez; si el portal no responde, se vuelve a intentar en la siguiente pasada.
async function revisarConfirmaciones(admin: SupabaseClient, s: Sesion, cuenta: string, escribir: boolean) {
  const out = { revisados: 0, borradores: [] as string[], confirmados: [] as string[] };
  const desde = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data } = await admin.from('informes')
    .select('id, parte_id, asignacion_id, creado_en, parte:partes!inner(id, numero_servicio, sigma_cuenta, estado, sigma_confirmado_en), asig:asignaciones(fecha, hora)')
    .is('sigma_confir_revisado_en', null).gte('creado_en', desde).eq('parte.sigma_cuenta', cuenta)
    .order('creado_en').limit(40);
  // deno-lint-ignore no-explicit-any
  const cola = ((data || []) as any[]).filter((i) => i.parte && !['cerrado', 'anulado'].includes(i.parte.estado));
  const marcar = async (ids: string[]) => { if (escribir && ids.length) await admin.from('informes').update({ sigma_confir_revisado_en: new Date().toISOString() }).in('id', ids); };
  // Informes de servicios ya confirmados o cerrados: nada que hacer
  await marcar(((data || []) as { id: string }[]).filter((i) => !cola.includes(i)).map((i) => i.id));
  const yaConfirmados = cola.filter((i) => i.parte.sigma_confirmado_en);
  await marcar(yaConfirmados.map((i) => i.id));
  const pendientes = cola.filter((i) => !i.parte.sigma_confirmado_en).slice(0, MAX_CONFIR);
  if (!pendientes.length) return out;
  const ut = await paseConfirmacion(s, pendientes[0].parte.numero_servicio);
  if (!ut) return out;
  await cargarTextosFnol();
  const vistos = new Map<string, EstadoConfir>();
  for (const i of pendientes) {
    const n = i.parte.numero_servicio as string;
    let est = vistos.get(n);
    if (!est) {
      try { est = await estadoConfirmacion(ut, n); } catch (err) { console.error('confirmación', n, (err as Error).message); continue; }
      vistos.set(n, est);
      out.revisados++;
    }
    if (!escribir) { if (est.estado === 'rapida' || est.estado === 'completa') out.borradores.push(`${n} (${est.estado})`); continue; }
    if (est.estado === 'confirmado') {
      await admin.from('partes').update({ sigma_confirmado_en: new Date().toISOString() }).eq('id', i.parte_id).is('sigma_confirmado_en', null);
      if (!out.confirmados.includes(n)) out.confirmados.push(n);
      // Si quedaba un borrador vivo de una variante completa, ya está hecha en el portal
      await admin.from('sigma_envios').update({ estado: 'enviado', resultado: 'Confirmación hecha en el portal (comprobado por el robot)', enviado_en: new Date().toISOString() })
        .eq('parte_id', i.parte_id).eq('tipo', 'confirmacion').in('estado', ['borrador', 'error']);
    } else if (est.estado === 'rapida' || est.estado === 'completa') {
      const { data: viva } = await admin.from('sigma_envios').select('id').eq('parte_id', i.parte_id).eq('tipo', 'confirmacion')
        .in('estado', ['borrador', 'aprobado', 'enviando', 'error']).limit(1);
      if (!viva?.length) {
        const { error } = await admin.from('sigma_envios').insert({
          parte_id: i.parte_id, asignacion_id: i.asignacion_id, informe_id: i.id, tipo: 'confirmacion', origen: 'informe',
          confir_variante: est.estado, confir_datos: est.datos, cita_fecha: i.asig?.fecha ?? null, cita_hora: i.asig?.hora ?? null,
          comentario: '',
        });
        if (error) { console.error('borrador confirmación', n, error.message); continue; }
        out.borradores.push(`${n} (${est.estado})`);
      }
    } else {
      console.log('confirmación no aplica', n, est.motivo);
    }
    await marcar([i.id]);
  }
  return out;
}

// Bloqueo del Repaso por documento de IVA: se comprueba en el portal (solo lectura) y se marca en partes.sigma_iva_pendiente.
// Primero los que tienen en la bitácora un «Documento de Iva pendiente de Validar» posterior a su última comprobación
// (v25, 30/10/2026: antes un servicio libre solo se volvía a mirar a las 6 h y seguía contando, p. ej. 29480757), luego los
// ya bloqueados (para desbloquearlos), luego los de Repasos (caducadas, sin primer contacto), luego el resto.
// Hora de Madrid «aaaa-mm-dd hh:mm», igual que las fechas de la bitácora
const horaMadrid = (iso: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)).replace('T', ' ').slice(0, 16);
// deno-lint-ignore no-explicit-any
function avisoIvaNuevo(p: any) {
  const aviso = (Array.isArray(p.sigma_bitacora) ? p.sigma_bitacora : [])
    .filter((x: { fecha?: string; texto?: string }) => x?.fecha && IVA_PENDIENTE.test(x.texto ?? ''))
    .map((x: { fecha: string }) => String(x.fecha).slice(0, 16)).sort().pop();
  if (!aviso) return false;
  return !p.sigma_iva_revisado_en || aviso >= horaMadrid(p.sigma_iva_revisado_en);
}
async function revisarIva(admin: SupabaseClient, s: Sesion, ciaId: number, cuenta: string, vivos: string[], prioridad: Set<string>, escribir: boolean) {
  const { data } = await admin.from('partes').select('id, numero_servicio, sigma_iva_pendiente, sigma_iva_revisado_en, sigma_bitacora')
    .eq('compania_id', ciaId).eq('sigma_cuenta', cuenta).in('numero_servicio', vivos.length ? vivos : ['-']);
  const ahoraMs = Date.now();
  const cola = (data || []).map((p) => ({ ...p, nuevo: !p.sigma_iva_pendiente && avisoIvaNuevo(p) })).filter((p) => {
    if (p.nuevo) return true;
    const edad = p.sigma_iva_revisado_en ? (ahoraMs - new Date(p.sigma_iva_revisado_en).getTime()) / 60000 : 1e9;
    return p.sigma_iva_pendiente ? edad > IVA_MARCADO_MIN : edad > IVA_LIBRE_H * 60;
  }).sort((a, b) => (Number(b.nuevo) - Number(a.nuevo))
    || (Number(!!b.sigma_iva_pendiente) - Number(!!a.sigma_iva_pendiente))
    || (Number(prioridad.has(b.numero_servicio)) - Number(prioridad.has(a.numero_servicio)))
    || String(a.sigma_iva_revisado_en ?? '').localeCompare(String(b.sigma_iva_revisado_en ?? ''))).slice(0, MAX_IVA);
  const out = { revisados: 0, bloqueados: [] as string[], desbloqueados: [] as string[] };
  if (!cola.length) return out;
  const ut = await paseRepaso(s, cola[0].numero_servicio);
  if (!ut) return out;
  for (const p of cola) {
    const est = await estadoRepaso(ut, p.numero_servicio);
    if (est === null) continue;
    out.revisados++;
    const ahora = new Date().toISOString();
    const d: Record<string, unknown> = { sigma_iva_revisado_en: ahora };
    if (est === 'iva') { out.bloqueados.push(p.numero_servicio); if (!p.sigma_iva_pendiente) d.sigma_iva_pendiente = ahora; }
    else if (p.sigma_iva_pendiente) { d.sigma_iva_pendiente = null; out.desbloqueados.push(p.numero_servicio); }
    if (escribir) await admin.from('partes').update(d).eq('id', p.id);
  }
  return out;
}

const ORDEN_ENVIO: Record<string, number> = { informar_cita: 0, confirmacion: 1, repaso: 2, tramitacion: 3 };
async function procesarEnvios(admin: SupabaseClient, cuenta: string, nombre: string, usuario: string, clave: string, secretoAvisos: string) {
  // Envíos que se quedaron a medias hace más de 10 min: no se reintentan solos (podría duplicarse en el portal)
  await admin.from('sigma_envios').update({ estado: 'error', resultado: 'Envío interrumpido: comprueba en el portal si se guardó antes de reintentar' })
    .eq('estado', 'enviando').lt('actualizado_en', new Date(Date.now() - 10 * 60000).toISOString());
  const { data: cola } = await admin.from('sigma_envios')
    .select('*, parte:partes!inner(numero_servicio, sigma_cuenta, estado)').eq('estado', 'aprobado').eq('parte.sigma_cuenta', cuenta)
    .order('creado_en');
  if (!cola?.length) return { enviados: 0, errores: 0 };
  // Reservar (evita que dos pasadas manden lo mismo)
  const { data: mios } = await admin.from('sigma_envios').update({ estado: 'enviando' })
    .in('id', cola.map((x) => x.id)).eq('estado', 'aprobado').select('id');
  const ids = new Set((mios || []).map((x) => x.id));
  const lista = (cola as Envio[]).filter((x) => ids.has(x.id))
    // Orden: Informar citas → Confirmación → Repaso → mensajes a tramitación (SIGMA no deja hacer Repaso con la confirmación pendiente)
    .sort((a, b) => (ORDEN_ENVIO[a.tipo] ?? 9) - (ORDEN_ENVIO[b.tipo] ?? 9) || String(a.creado_en).localeCompare(String(b.creado_en)));
  if (!lista.length) return { enviados: 0, errores: 0 };
  const s = new Sesion();
  await entrar(s, usuario, clave);
  const fallidos = new Set<string>();
  let enviados = 0; const errores: string[] = [];
  for (const e of lista) {
    try {
      if (fallidos.has(e.parte_id) && e.tipo !== 'tramitacion') throw new Error('No se envió porque falló el envío anterior de este servicio');
      if (e.tipo === 'repaso' && e.parte.estado === 'cerrado') throw new Error(CODIGOS_REPASO['3057']);
      const r = e.tipo === 'repaso' ? await enviarRepaso(s, e) : e.tipo === 'tramitacion' ? await enviarTramitacion(s, e)
        : e.tipo === 'confirmacion' ? await enviarConfirmacion(s, e) : await enviarInformarCita(s, e);
      if (e.tipo === 'confirmacion') await admin.from('partes').update({ sigma_confirmado_en: new Date().toISOString() }).eq('id', e.parte_id);
      if (e.tipo === 'repaso') await admin.from('partes').update({ sigma_iva_pendiente: null, sigma_iva_revisado_en: new Date().toISOString() }).eq('id', e.parte_id);
      await admin.from('sigma_envios').update({ estado: 'enviado', resultado: r, enviado_en: new Date().toISOString(), intentos: 1 }).eq('id', e.id);
      await admin.from('partes').update({ sigma_ficha_en: null }).eq('id', e.parte_id); // releer la ficha en la próxima pasada
      enviados++;
    } catch (err) {
      // Informar cita sin cita pendiente en el portal: se descarta solo, sin error ni aviso (decisión del usuario 23/10/2026)
      if (err instanceof SinCitaPendiente && e.tipo === 'informar_cita') {
        await admin.from('sigma_envios').update({ estado: 'descartado', resultado: SIN_CITA }).eq('id', e.id);
        await admin.from('partes').update({ sigma_ficha_en: null }).eq('id', e.parte_id);
        continue;
      }
      // Aplazamiento en un siniestro sin confirmar (código 1212): se descarta solo, sin error ni aviso (decisión del usuario 27/10/2026)
      // Estado 6 o 16: igual (decisión del usuario 04/11/2026). Se relee la ficha para que la oficina vea el bloqueo cuanto antes
      if ((err instanceof SinConfirmar || err instanceof BloqueadoPorEstado) && e.tipo === 'repaso') {
        await admin.from('sigma_envios').update({ estado: 'descartado', resultado: (err as Error).message }).eq('id', e.id);
        await admin.from('partes').update({ sigma_ficha_en: null }).eq('id', e.parte_id);
        continue;
      }
      if (e.tipo !== 'tramitacion') fallidos.add(e.parte_id);
      const msg = err instanceof IvaPendiente ? BLOQUEO_IVA : (err as Error).message;
      if (err instanceof IvaPendiente) {
        const ahora = new Date().toISOString();
        await admin.from('partes').update({ sigma_iva_pendiente: ahora, sigma_iva_revisado_en: ahora }).eq('id', e.parte_id).is('sigma_iva_pendiente', null);
        await admin.from('partes').update({ sigma_iva_revisado_en: ahora }).eq('id', e.parte_id);
      }
      await admin.from('sigma_envios').update({ estado: 'error', resultado: msg }).eq('id', e.id);
      errores.push(`${e.parte.numero_servicio}: ${msg}`);
    }
  }
  if (errores.length) {
    try {
      await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/notificar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kubel-secreto': secretoAvisos },
        body: JSON.stringify({ tabla: 'sigma', evento: 'resumen', nuevo: { cuenta, nombre, error: `Envío a SIGMA fallido · ${errores.slice(0, 2).join(' · ')}${errores.length > 2 ? ' …' : ''}` } }),
      });
    } catch (err) { console.error('aviso envíos', (err as Error).message); }
  }
  return { enviados, errores: errores.length };
}

// ---------------------------------------------------------------- sincronización de una cuenta
type Resumen = {
  cuenta: string; ok: boolean; en_listado: number; total_portal: number | null; paginas: number;
  nuevos: { numero: string; direccion: string; gremio: string; urgente: boolean }[];
  cambiados: number; fichas: number; desaparecidos: string[]; pendientes: number; error?: string; diagnostico?: unknown;
  aceptados?: Ofrecido[]; sin_contacto?: number; caducadas?: number; cerrados?: string[]; anulados?: string[]; reabiertos?: string[];
  iva?: { revisados: number; bloqueados: string[]; desbloqueados: string[] };
  confirmacion?: { revisados: number; borradores: string[]; confirmados: string[] };
};

function partirDireccion(d: string) {
  const m = d.match(/^(.*?)\s+-\s+(\d{5})\s+(.*)$/);
  return m ? { direccion: m[1].trim(), cp: m[2], poblacion: m[3].trim() } : { direccion: d, cp: null, poblacion: null };
}
const vacio = (v: unknown) => v === null || v === undefined || v === '';

// r se rellena sobre la marcha: si algo falla a mitad, lo ya hecho (p. ej. aceptados) no se pierde
async function sincronizar(admin: SupabaseClient, ciaId: number, usuario: string, clave: string, prueba: boolean, r: Resumen): Promise<Resumen> {
  const cuenta = r.cuenta;
  const s = new Sesion();
  await entrar(s, usuario, clave);

  let lis: Awaited<ReturnType<typeof leerTodoElListado>>;
  try {
    lis = await leerTodoElListado(s);
  } catch (err) {
    if ((err as Error).message !== PENDIENTES) throw err;
    if (prueba) {
      const doc = parse(await s.pedir('confirmserv.php'));
      const form = doc.querySelector('form[name="confirmserv"]') as Element | null;
      r.aceptados = (form ? leerOfrecidos(form) : []).map((o) => ({ ...o, domicilio: '' }));
      r.ok = true; r.diagnostico = { ofrecidos_pendientes: r.aceptados.length, nota: 'En modo prueba no se aceptan' };
      return r;
    }
    r.aceptados = await aceptarOfrecidos(s);
    lis = await leerTodoElListado(s);
  }
  const sinContactoPortal = await leerSinContacto(s);
  const caducadasPortal = await leerCaducadas(s);
  r.en_listado = lis.filas.length; r.total_portal = lis.total; r.paginas = lis.paginas;
  const completo = lis.total !== null && lis.filas.length === lis.total;

  // Tablas de códigos
  const { data: cods } = await admin.from('sigma_codigos').select('tipo, codigo, texto, gremio_kubel');
  const mapa = new Map((cods || []).map((c) => [`${c.tipo}:${c.codigo}`, c]));
  const nuevosCodigos = lis.codigos.filter((c) => {
    const k = mapa.get(`${c.tipo}:${c.codigo}`);
    return !k || (c.texto && k.texto !== c.texto && c.tipo !== 'procedencia');
  });
  const gremioKubel = (cod: string) => {
    const g = mapa.get(`gremio:${cod}`) ?? nuevosCodigos.find((c) => c.tipo === 'gremio' && c.codigo === cod);
    return (g as { gremio_kubel?: string })?.gremio_kubel || g?.texto || cod || null;
  };

  // Lo que ya tenemos
  const numeros = lis.filas.map((f) => f.numero);
  const campos = 'id, numero_servicio, asegurado, telefono, telefono2, direccion, poblacion, codigo_postal, gremio, descripcion, urgente, sigma_cuenta, sigma_huella, sigma_en_curso, sigma_ficha_en, estado, sigma_ficha';
  const existentes = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < numeros.length; i += 200) {
    const { data, error } = await admin.from('partes').select(campos).eq('compania_id', ciaId).in('numero_servicio', numeros.slice(i, i + 200));
    if (error) throw error;
    (data || []).forEach((p) => existentes.set(p.numero_servicio, p));
  }
  const { data: enCurso, error: e2 } = await admin.from('partes').select('id, numero_servicio').eq('compania_id', ciaId).eq('sigma_cuenta', cuenta).eq('sigma_en_curso', true);
  if (e2) throw e2;

  const ahora = new Date().toISOString();
  const altas: Record<string, unknown>[] = [];
  const cambios: { id: string; datos: Record<string, unknown> }[] = [];
  const colaFichas: { numero: string; prio: number; edad: number }[] = [];
  const nuevosLista: Resumen['nuevos'] = [];

  for (const f of lis.filas) {
    const huella = JSON.stringify([f.profesional, f.procedencia, f.gremio, f.caducidad, f.duracion, f.llamadas, f.estado, f.alerta, f.marcas, f.direccion, f.descripcion]);
    const datosLista = {
      sigma_cuenta: cuenta, sigma_profesional: f.profesional, sigma_procedencia: f.procedencia, sigma_gremio: f.gremio,
      sigma_estado: f.estado, sigma_caducidad: f.caducidad, sigma_duracion: f.duracion, sigma_llamadas: f.llamadas,
      sigma_alerta: f.alerta, sigma_marcas: f.marcas, sigma_en_curso: true, sigma_huella: huella, sigma_cambio_en: ahora,
    };
    const e = existentes.get(f.numero);
    if (!e) {
      const d = partirDireccion(f.direccion);
      const urgente = f.marcas.some((m) => /urgente/i.test(m));
      altas.push({
        compania_id: ciaId, numero_servicio: f.numero, origen: 'sigma',
        direccion: d.direccion || '(sin dirección)', codigo_postal: d.cp, poblacion: d.poblacion,
        gremio: gremioKubel(f.gremio), descripcion: f.descripcion || null, urgente, ...datosLista,
      });
      nuevosLista.push({ numero: f.numero, direccion: [d.direccion, d.poblacion].filter(Boolean).join(', '), gremio: String(gremioKubel(f.gremio) ?? ''), urgente });
      colaFichas.push({ numero: f.numero, prio: 0, edad: 0 });
    } else if (e.sigma_huella !== huella || e.sigma_en_curso !== true || e.sigma_cuenta !== cuenta) {
      r.cambiados++;
      const datos: Record<string, unknown> = { ...datosLista, sigma_ficha_en: null };
      const fx = e.sigma_ficha as Record<string, unknown> | null;
      if ((e.estado === 'cerrado' && fx?.cierre_auto) || (e.estado === 'anulado' && fx?.anulado_auto)) {
        datos.estado = 'pendiente'; // se ajusta a "asignado" más abajo si tiene visitas
        (r.reabiertos ??= []).push(f.numero);
      }
      cambios.push({ id: e.id as string, datos });
      colaFichas.push({ numero: f.numero, prio: 1, edad: 0 });
    } else {
      const edad = e.sigma_ficha_en ? (Date.now() - new Date(e.sigma_ficha_en as string).getTime()) / 3600000 : 1e6;
      if (edad > REFRESCO_FICHA_H) colaFichas.push({ numero: f.numero, prio: e.sigma_ficha_en ? 3 : 2, edad });
    }
  }

  // Servicios que ya no salen en el listado (solo si el listado se leyó completo)
  const desaparecidos: string[] = [];
  if (completo) {
    const vivos = new Set(numeros);
    for (const p of enCurso || []) if (!vivos.has(p.numero_servicio)) desaparecidos.push(p.numero_servicio);
  }

  // CERRADOS: los que salen de "en curso" se releen para ver si SIGMA los ha cerrado.
  // Los de esta pasada enseguida; los de días anteriores sin cerrar, cada FUERA_REFRESCO_H horas (hasta FUERA_DIAS días).
  const fuera = new Set<string>(desaparecidos);
  {
    const limite = new Date(Date.now() - FUERA_DIAS * 86400000).toISOString();
    const viejo = new Date(Date.now() - FUERA_REFRESCO_H * 3600000).toISOString();
    const { data: sinCerrar } = await admin.from('partes').select('numero_servicio, sigma_ficha_en')
      .eq('compania_id', ciaId).eq('sigma_cuenta', cuenta).eq('sigma_en_curso', false)
      .not('estado', 'in', '(cerrado,anulado)').gte('sigma_cambio_en', limite)
      .or(`sigma_ficha_en.is.null,sigma_ficha_en.lt.${viejo}`).limit(MAX_FUERA);
    if (completo) for (const p of sinCerrar || []) if (!numeros.includes(p.numero_servicio)) fuera.add(p.numero_servicio);
  }
  for (const n of fuera) colaFichas.push({ numero: n, prio: desaparecidos.includes(n) ? 1 : 2.5, edad: 0 });

  // Fichas: primero nuevos, luego cambiados (y recién salidos), luego las nunca leídas, luego fuera de curso, luego las más antiguas
  colaFichas.sort((a, b) => a.prio - b.prio || b.edad - a.edad);
  const aLeer = colaFichas.slice(0, MAX_FICHAS);
  r.pendientes = colaFichas.length - aLeer.length;
  const fichas = new Map<string, ReturnType<typeof leerFicha>>();
  const erroresFicha: string[] = [];
  const retirados = new Set<string>(); // fuera de curso + "No Pertenece Al Profesional" con su propia cuenta
  let idx = 0;
  await Promise.all(Array.from({ length: PARALELO }, async () => {
    while (idx < aLeer.length) {
      const { numero } = aLeer[idx++];
      try {
        fichas.set(numero, leerFicha(await s.pedir(`repasos1.php?reparacion=${numero}`)));
      } catch (err) {
        if (err instanceof NoPertenece && fuera.has(numero)) retirados.add(numero);
        else if (fuera.has(numero)) console.error('ficha fuera de curso', numero, (err as Error).message);
        else erroresFicha.push(`${numero}: ${(err as Error).message}`);
      }
    }
  }));
  r.fichas = fichas.size;
  if (erroresFicha.length && ![...fichas.keys()].some((n) => !fuera.has(n))) throw new Error('No se pudo leer ninguna ficha: ' + erroresFicha[0]);
  // Procedencia: el código sale en el listado y el nombre en la ficha
  const porNumero = new Map(lis.filas.map((f) => [f.numero, f]));
  for (const [n, f] of fichas) {
    const cod = porNumero.get(n)?.procedencia;
    if (cod && f.procedenciaTexto) nuevosCodigos.push({ tipo: 'procedencia', codigo: cod, texto: f.procedenciaTexto });
  }

  const prioridadIva = new Set<string>([...(caducadasPortal?.keys() ?? []), ...(sinContactoPortal ?? []), ...lis.filas.filter((f) => f.estado === '15').map((f) => f.numero)]);
  if (prueba) {
    try { r.iva = await revisarIva(admin, s, ciaId, cuenta, numeros, prioridadIva, false); } catch (err) { console.error('iva', (err as Error).message); }
    try { r.confirmacion = await revisarConfirmaciones(admin, s, cuenta, false); } catch (err) { console.error('confirmación', (err as Error).message); }
    r.nuevos = nuevosLista; r.desaparecidos = desaparecidos;
    const una = fichas.values().next().value;
    r.diagnostico = {
      listado_completo: completo, filas_leidas: lis.leidas, codigos_leidos: lis.codigos.length, aviso_portal: lis.aviso,
      alertas: lis.filas.reduce((a, f) => ((a[f.alerta] = (a[f.alerta] || 0) + 1), a), {} as Record<string, number>),
      marcas: [...new Set(lis.filas.flatMap((f) => f.marcas))],
      filas_sin_direccion: lis.filas.filter((f) => !f.direccion).length,
      errores_ficha: erroresFicha.slice(0, 5),
      fuera_de_curso: [...fuera].map((n) => ({ numero: n, leida: fichas.has(n), cierre: fichas.get(n)?.otros.cierre ?? null, retirado: retirados.has(n) })),
      sin_primer_contacto: { portal: sinContactoPortal ? [...sinContactoPortal] : 'no leído', estado_15: lis.filas.filter((f) => f.estado === '15').map((f) => f.numero) },
      caducadas: caducadasPortal ? Object.fromEntries(['redes', 'resto', 'cliente'].map((g) => [g, [...caducadasPortal].filter(([, x]) => x === g).map(([n]) => n)])) : 'no leído',
      procedencias: [...new Map(nuevosCodigos.filter((c) => c.tipo === 'procedencia' && c.texto).map((c) => [c.codigo, c.texto])).entries()],
      ficha_ejemplo: una && {
        tiene_cliente: !!una.cliente, tiene_direccion: !!una.direccion, cp: !!una.cp, procedencia: !!una.procedenciaTexto,
        urgente: una.urgente, estado: !!una.estadoTexto, telefonos: una.telefonos.length, entradas_bitacora: una.bitacora.length,
        descripcion_inicial: una.descripcion.length, otros: Object.entries(una.otros).filter(([, v]) => v).map(([k]) => k),
      },
    };
    r.nuevos = r.nuevos.map((n) => ({ ...n, direccion: '' }));
    r.ok = true;
    return r;
  }

  // ----- Escritura
  if (nuevosCodigos.length) {
    const filas = [...new Map(nuevosCodigos.map((c) => [`${c.tipo}:${c.codigo}`, c])).values()]
      .map((c) => ({ ...c, texto: c.texto ?? mapa.get(`${c.tipo}:${c.codigo}`)?.texto ?? null, actualizado_en: ahora }));
    const { error } = await admin.from('sigma_codigos').upsert(filas, { onConflict: 'tipo,codigo' });
    if (error) console.error('códigos', error.message);
  }
  if (altas.length) {
    const { error } = await admin.from('partes').insert(altas);
    if (error) throw new Error('Alta de partes: ' + error.message);
  }
  r.nuevos = nuevosLista; // solo cuentan como nuevos si se han dado de alta
  for (const c of cambios) {
    const { error } = await admin.from('partes').update(c.datos).eq('id', c.id);
    if (error) throw new Error('Actualizar parte: ' + error.message);
  }
  if (r.reabiertos?.length) {
    const { data: conVisita } = await admin.from('asignaciones').select('parte_id, partes!inner(numero_servicio, compania_id)')
      .eq('partes.compania_id', ciaId).in('partes.numero_servicio', r.reabiertos);
    const ids = [...new Set((conVisita || []).map((a) => a.parte_id))];
    if (ids.length) await admin.from('partes').update({ estado: 'asignado' }).in('id', ids).eq('estado', 'pendiente');
  }
  if (desaparecidos.length) {
    const { error } = await admin.from('partes').update({ sigma_en_curso: false, sigma_cambio_en: ahora })
      .eq('compania_id', ciaId).eq('sigma_cuenta', cuenta).in('numero_servicio', desaparecidos);
    if (error) throw new Error('Marcar desaparecidos: ' + error.message);
    r.desaparecidos = desaparecidos;
  }
  // SIN PRIMER CONTACTO: lista de Gestión repaso del portal + estado 15 "Primer contacto con cliente"
  {
    const { data: marcados } = await admin.from('partes').select('id, numero_servicio, sigma_estado, sigma_en_curso')
      .eq('compania_id', ciaId).eq('sigma_cuenta', cuenta).eq('sigma_sin_contacto', true);
    const estadoDe = new Map(lis.filas.map((f) => [f.numero, f.estado]));
    const sinContacto = new Set<string>(lis.filas.filter((f) => f.estado === '15').map((f) => f.numero));
    if (sinContactoPortal) sinContactoPortal.forEach((n) => estadoDe.has(n) && sinContacto.add(n));
    else for (const m of marcados || []) { // portal no leído: se conservan las marcas que siguen en curso y sin cambio claro
      const est = estadoDe.get(m.numero_servicio);
      if (est !== undefined && (est === m.sigma_estado || est === '15')) sinContacto.add(m.numero_servicio);
    }
    const quitar = (marcados || []).filter((m) => !sinContacto.has(m.numero_servicio)).map((m) => m.id);
    const ya = new Set((marcados || []).map((m) => m.numero_servicio));
    const poner = [...sinContacto].filter((n) => !ya.has(n));
    if (quitar.length) {
      const { error } = await admin.from('partes').update({ sigma_sin_contacto: false, sigma_sin_contacto_desde: null }).in('id', quitar);
      if (error) console.error('sin contacto (quitar)', error.message);
    }
    if (poner.length) {
      const { error } = await admin.from('partes').update({ sigma_sin_contacto: true, sigma_sin_contacto_desde: ahora })
        .eq('compania_id', ciaId).in('numero_servicio', poner);
      if (error) console.error('sin contacto (poner)', error.message);
    }
    r.sin_contacto = sinContacto.size;
  }
  // CADUCADAS / CADUCAN HOY: entradas, cambios de grupo y salidas (con el estado de antes y de después)
  if (caducadasPortal) {
    const { data: marcados } = await admin.from('partes').select('id, numero_servicio, sigma_cad_grupo')
      .eq('compania_id', ciaId).eq('sigma_cuenta', cuenta).not('sigma_cad_desde', 'is', null).is('sigma_cad_hasta', null);
    const estadoDe = new Map(lis.filas.map((f) => [f.numero, f.estado]));
    const ya = new Map((marcados || []).map((m) => [m.numero_servicio, m]));
    for (const m of marcados || []) {
      const g = caducadasPortal.get(m.numero_servicio);
      if (!g) {
        const { error } = await admin.from('partes').update({ sigma_cad_hasta: ahora, sigma_cad_estado_fin: estadoDe.get(m.numero_servicio) ?? null }).eq('id', m.id);
        if (error) console.error('caducadas (salida)', error.message);
      } else if (g !== m.sigma_cad_grupo) {
        await admin.from('partes').update({ sigma_cad_grupo: g }).eq('id', m.id);
      }
    }
    for (const [n, g] of caducadasPortal) {
      if (ya.has(n) || !estadoDe.has(n)) continue;
      const { error } = await admin.from('partes').update({
        sigma_cad_grupo: g, sigma_cad_desde: ahora, sigma_cad_hasta: null, sigma_cad_estado: estadoDe.get(n), sigma_cad_estado_fin: null,
      }).eq('compania_id', ciaId).eq('numero_servicio', n);
      if (error) console.error('caducadas (entrada)', error.message);
    }
    r.caducadas = caducadasPortal.size;
  }
  // Datos de las fichas: los campos SIGMA siempre; los generales solo si están vacíos (no pisar a la oficina)
  if (fichas.size) {
    const { data: actuales } = await admin.from('partes').select(campos).eq('compania_id', ciaId).in('numero_servicio', [...fichas.keys()]);
    for (const p of actuales || []) {
      const f = fichas.get(p.numero_servicio)!;
      const tels = f.telefonos.filter((t) => t.de === 'cliente').map((t) => t.numero);
      const d: Record<string, unknown> = {
        sigma_poliza: f.poliza, sigma_telefonos: f.telefonos, sigma_bitacora: f.bitacora,
        sigma_estado_texto: f.estadoTexto, sigma_ficha: f.otros, sigma_ficha_en: ahora,
      };
      // Cerrado en SIGMA: tiene fecha de cierre y ya no está en "Servicios en curso"
      if (f.otros.cierre && fuera.has(p.numero_servicio) && !['cerrado', 'anulado'].includes(p.estado as string)) {
        d.estado = 'cerrado';
        d.sigma_ficha = { ...f.otros, cierre_auto: ahora, estado_antes: p.estado };
        d.sigma_sin_contacto = false; d.sigma_sin_contacto_desde = null;
        (r.cerrados ??= []).push(p.numero_servicio);
        // Lo que quedaba pendiente en la bandeja ya no se puede enviar (el portal responde 3057)
        const { error: eDesc } = await admin.from('sigma_envios').update({ estado: 'descartado', resultado: `Descartado solo: SIGMA cerró el servicio (${f.otros.cierre})` })
          .eq('parte_id', p.id).in('estado', ['borrador', 'aprobado', 'error']);
        if (eDesc) console.error('descartar envíos', p.numero_servicio, eDesc.message);
      } else if (p.estado === 'cerrado' && (p.sigma_ficha as Record<string, unknown> | null)?.cierre_auto) {
        d.sigma_ficha = { ...f.otros, cierre_auto: (p.sigma_ficha as Record<string, unknown>).cierre_auto, estado_antes: (p.sigma_ficha as Record<string, unknown>).estado_antes };
      }
      if (vacio(p.asegurado) && f.cliente) d.asegurado = f.cliente;
      if (vacio(p.telefono) && tels[0]) d.telefono = tels[0];
      if (vacio(p.telefono2) && tels[1]) d.telefono2 = tels[1];
      if ((vacio(p.direccion) || p.direccion === '(sin dirección)') && f.direccion) d.direccion = f.direccion;
      if (vacio(p.codigo_postal) && f.cp) d.codigo_postal = f.cp;
      if (vacio(p.poblacion) && f.poblacion) d.poblacion = f.poblacion;
      if (f.descripcion && (vacio(p.descripcion) || (String(p.descripcion).endsWith('...') && f.descripcion.length > String(p.descripcion).length))) d.descripcion = f.descripcion;
      if (f.urgente && !p.urgente) d.urgente = true;
      const { error } = await admin.from('partes').update(d).eq('id', p.id);
      if (error) console.error('ficha', p.numero_servicio, error.message);
    }
  }
  // RETIRADOS / ANULADOS POR SIGMA: ya no salen en curso y el portal dice que no son nuestros → Anulado
  if (retirados.size) {
    const { data: actuales } = await admin.from('partes').select('id, numero_servicio, estado, sigma_ficha')
      .eq('compania_id', ciaId).eq('sigma_cuenta', cuenta).eq('sigma_en_curso', false)
      .in('numero_servicio', [...retirados]).not('estado', 'in', '(cerrado,anulado)');
    for (const p of actuales || []) {
      const { error } = await admin.from('partes').update({
        estado: 'anulado', sigma_ficha_en: ahora, sigma_sin_contacto: false, sigma_sin_contacto_desde: null, sigma_iva_pendiente: null,
        sigma_ficha: { ...((p.sigma_ficha as Record<string, unknown>) ?? {}), anulado_auto: ahora, estado_antes: p.estado, anulado_motivo: 'La Reparación No Pertenece Al Profesional' },
      }).eq('id', p.id);
      if (error) { console.error('anular', p.numero_servicio, error.message); continue; }
      await admin.from('partes').update({ sigma_cad_hasta: ahora, sigma_cad_estado_fin: null }).eq('id', p.id).not('sigma_cad_desde', 'is', null).is('sigma_cad_hasta', null);
      const { error: eDesc } = await admin.from('sigma_envios').update({ estado: 'descartado', resultado: 'Descartado solo: SIGMA ha retirado o anulado el servicio (no pertenece al profesional)' })
        .eq('parte_id', p.id).in('estado', ['borrador', 'aprobado', 'error']);
      if (eDesc) console.error('descartar envíos', p.numero_servicio, eDesc.message);
      (r.anulados ??= []).push(p.numero_servicio);
    }
  }
  // BLOQUEO POR DOCUMENTO DE IVA (solo lectura en el portal; no afecta al resultado de la pasada si falla)
  try { r.iva = await revisarIva(admin, s, ciaId, cuenta, numeros, prioridadIva, true); } catch (err) { console.error('iva', (err as Error).message); }
  // CONFIRMACIÓN: informes nuevos de servicios sin confirmar → borrador para la oficina (solo lectura en el portal)
  try { r.confirmacion = await revisarConfirmaciones(admin, s, cuenta, true); } catch (err) { console.error('confirmación', (err as Error).message); }
  if (erroresFicha.length) r.error = `Fichas con error: ${erroresFicha.length}`;
  r.ok = true;
  return r;
}

// ---------------------------------------------------------------- entrada
let secreto: string | null = null;
async function leerSecreto() {
  if (secreto) return secreto;
  const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });
  try {
    const [f] = await sql`select valor from privado.ajustes where clave = 'notif_secreto'`;
    secreto = f?.valor ?? null;
  } finally {
    await sql.end();
  }
  return secreto;
}

Deno.serve(async (req) => {
  const s = await leerSecreto();
  if (!s || req.headers.get('x-kubel-secreto') !== s) return new Response('no', { status: 401 });
  const url = new URL(req.url);
  const prueba = url.searchParams.get('prueba') === '1';
  const solo = url.searchParams.get('cuenta');
  const soloEnviar = url.searchParams.get('enviar') === '1';
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: cia } = await admin.from('companias').select('id').eq('nombre', 'SIGMA').single();
  const resultados: Resumen[] = [];
  const verConfir = url.searchParams.get('verconfir');
  if (verConfir) { // solo lectura: qué dice el portal de la Confirmación de un servicio
    const c = CUENTAS.find((x) => x.id === (solo || 'VLL'))!;
    const ses = new Sesion();
    await entrar(ses, Deno.env.get(`SIGMA_${c.id}_USUARIO`)!, Deno.env.get(`SIGMA_${c.id}_CLAVE`)!);
    const ut = await paseConfirmacion(ses, verConfir);
    if (!ut) return new Response(JSON.stringify({ error: 'sin pase de Confirmación' }), { headers: { 'Content-Type': 'application/json' } });
    await cargarTextosFnol();
    return new Response(JSON.stringify({ servicio: verConfir, cuenta: c.id, ...(await estadoConfirmacion(ut, verConfir)) }), { headers: { 'Content-Type': 'application/json' } });
  }

  for (const c of CUENTAS) {
    if (solo && solo !== c.id) continue;
    const usuario = Deno.env.get(`SIGMA_${c.id}_USUARIO`);
    const clave = Deno.env.get(`SIGMA_${c.id}_CLAVE`);
    if (!usuario || !clave) {
      resultados.push({ cuenta: c.id, ok: false, en_listado: 0, total_portal: null, paginas: 0, nuevos: [], cambiados: 0, fichas: 0, desaparecidos: [], pendientes: 0, error: 'Faltan las credenciales en los secretos' });
      continue;
    }
    if (soloEnviar) { // llamada inmediata al aprobar un envío en la oficina
      try { resultados.push({ cuenta: c.id, ...(await procesarEnvios(admin, c.id, c.nombre, usuario, clave, s)) } as unknown as Resumen); }
      catch (err) { console.error('envíos', c.id, err); }
      continue;
    }
    const { data: reg } = await admin.from('sigma_sincronizaciones').insert({ cuenta: c.id, prueba }).select('id').single();
    const r: Resumen = { cuenta: c.id, ok: false, en_listado: 0, total_portal: null, paginas: 0, nuevos: [], cambiados: 0, fichas: 0, desaparecidos: [], pendientes: 0 };
    try {
      await sincronizar(admin, cia!.id, usuario, clave, prueba, r);
    } catch (err) {
      console.error(c.id, err);
      r.ok = false; r.error = (err as Error).message;
    }
    if (!prueba) {
      try { await procesarEnvios(admin, c.id, c.nombre, usuario, clave, s); } catch (err) { console.error('envíos', c.id, err); }
    }
    resultados.push(r);
    if (reg) {
      await admin.from('sigma_sincronizaciones').update({
        fin: new Date().toISOString(), ok: r.ok, en_listado: r.en_listado, nuevos: r.nuevos.length, cambiados: r.cambiados,
        fichas: r.fichas, desaparecidos: r.desaparecidos.length, pendientes: r.pendientes, error: r.error ?? null,
        aceptados: r.aceptados?.length ?? 0,
      }).eq('id', reg.id);
    }
    // Avisos a la oficina (no en modo prueba)
    if (!prueba) {
      let avisarError = false;
      if (!r.ok) {
        const { data: ult } = await admin.from('sigma_sincronizaciones').select('ok, error').eq('cuenta', c.id).eq('prueba', false).order('inicio', { ascending: false }).limit(4);
        if (r.error === PENDIENTES || /ofrecid|ofrecimiento/i.test(r.error || '')) {
          avisarError = !(ult?.[1] && ult[1].error === r.error); // avisa en cuanto aparece, una vez
        } else {
          let fallos = (ult || []).findIndex((x) => x.ok !== false); if (fallos === -1) fallos = (ult || []).length;
          avisarError = fallos === 3; // avisa una vez, al tercer fallo seguido
        }
      }
      // Los aceptados ya tienen su propio aviso: no repetirlos como "nuevos"
      const nuevos = r.nuevos.filter((n) => !r.aceptados?.some((a) => a.numero === n.numero));
      if (avisarError || nuevos.length || r.desaparecidos.length || r.aceptados?.length) {
        try {
          await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/notificar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-kubel-secreto': s },
            body: JSON.stringify({ tabla: 'sigma', evento: 'resumen', nuevo: {
              cuenta: c.id, nombre: c.nombre, error: avisarError ? r.error : null,
              nuevos, desaparecidos: r.desaparecidos, aceptados: r.aceptados ?? [],
            } }),
          });
        } catch (err) { console.error('aviso', (err as Error).message); }
      }
    }
  }
  return new Response(JSON.stringify({ prueba, resultados }), { headers: { 'Content-Type': 'application/json' } });
});
