// KUBEL — Robot del portal TASHO (S.I.C.I., tasho.sistemasici.es).
// v1.1 (11/11/2026). SOLO LECTURA en TASHO: nunca graba, envía ni confirma nada en el portal.
// Entra con TASHO_USUARIO / TASHO_CLAVE y vuelca en `partes` (compañía 3, origen 'tasho'):
//   · «No informados» (buscador, estado_cita = N) y «Pendiente cita» → servicios abiertos.
//   · «Trabajos realizados» (últimos 120 días) → importe sin IVA por expediente (tasho_importe → Facturación).
//   · Nº del servicio = nº de expediente de la compañía final; un expediente puede tener varios partes.
//   · Adopta los servicios de TASHO dados de alta a mano (nº = Id Exp. o nº de Parte) en vez de duplicarlos.
//   · Cierre: un servicio abierto que ya no sale y aparece INFORMADO (buscador estado V o en Trabajos realizados)
//     → cerrado; si no aparece en ningún sitio → anulado (retirado). Si vuelve a salir sin informar → se reabre.
// Modos: (nada) pasada normal · ?prueba=1 lee y devuelve sin escribir · ?fn=<lectura>&args=<json> diagnóstico.
// Lo llama pg_cron (privado.lanzar_tasho_cron) y «↻ Comprobar en TASHO» (public.comprobar_tasho) con x-kubel-secreto.
import postgres from 'npm:postgres@3.4.4';

const BASE = 'https://tasho.sistemasici.es/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const COMPANIA = 3;
const TOPE_MS = 120_000;
const MAX_COMPROBAR = 15; // servicios desaparecidos que se comprueban por pasada

let secreto: string | null = null;
const sqlDb = () => postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });
async function leerSecreto() {
  if (secreto) return secreto;
  const sql = sqlDb();
  try {
    const [f] = await sql`select valor from privado.ajustes where clave = 'notif_secreto'`;
    secreto = f?.valor ?? null;
  } finally { await sql.end(); }
  return secreto;
}

// ───────────────────────── utilidades de texto ─────────────────────────
const sinToken = (u: string) => u.replace(/TOKEN=[^&]+/i, 'TOKEN=…');
const ent = (t: string) => t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const texto = (h: string) => ent(h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|tr|p|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' '))
  .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
const linea = (h: string) => texto(h).replace(/\s+/g, ' ').trim();
const RX_XTOKEN = /id=["']token["'][^>]*?value=["']([0-9a-f]{32})["']/i;
// "24-10-26 10:30 - 11:30" → "2026-10-24 10:30" (hora local de Madrid; en SQL se pasa a timestamptz)
const ddmmaa = (s: string) => {
  const m = s.match(/(\d{2})[-\/](\d{2})[-\/](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const a = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${a}-${m[2]}-${m[1]} ${m[4] ? m[4].padStart(2, '0') + ':' + m[5] : '00:00'}`;
};
const hoyMadrid = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
const fmt = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const num = (s: string) => { const v = Number(s.replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(v) ? v : null; };

// ───────────────────────── sesión en el portal ─────────────────────────
class Sesion {
  cookies = new Map<string, string>();
  pasos: string[] = [];
  ultima = BASE + 'index.php';
  token = '';
  xtoken = '';
  idOperario = '';
  private guardar(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0]; const i = kv.indexOf('=');
      if (i > 0) this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  async pedir(ruta: string, body?: string, xajax = false) {
    let url = ruta.startsWith('http') ? ruta : BASE + ruta;
    let method = body ? 'POST' : 'GET';
    for (let i = 0; i < 8; i++) {
      const headers: Record<string, string> = { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9', Accept: xajax ? '*/*' : 'text/html,application/xhtml+xml,*/*;q=0.8', Referer: this.ultima };
      if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'; headers.Origin = 'https://tasho.sistemasici.es'; }
      if (xajax) headers['X-Requested-With'] = 'XMLHttpRequest';
      const res = await fetch(url, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(40000) });
      this.guardar(res);
      const loc = res.headers.get('location');
      const u = new URL(url);
      this.pasos.push(`${method} ${sinToken(u.pathname + u.search)} → ${res.status}`);
      if (res.status >= 300 && res.status < 400 && loc) { await res.body?.cancel(); url = new URL(loc, url).href; method = 'GET'; body = undefined; continue; }
      const html = await res.text();
      if (!xajax) this.ultima = url;
      const m = url.match(/TOKEN=([^&]+)/i); if (m) this.token = m[1];
      return { html, url, status: res.status };
    }
    throw new Error('Demasiadas redirecciones');
  }
  async entrar(usuario: string, clave: string) {
    await this.pedir('index.php');
    const r = await this.pedir('index.php', new URLSearchParams({ usuario, contrasenya: clave, ENTRAR: '' }).toString());
    if (!this.token) { const m = r.html.match(/principalOperarios\.php\?TOKEN=([A-Za-z0-9]+)/); if (m) this.token = m[1]; }
    if (!this.token) {
      if (/NO VALIDO/i.test(r.html)) throw new Error('TASHO no acepta el usuario o la contraseña (revisar TASHO_USUARIO / TASHO_CLAVE)');
      throw new Error('No se pudo entrar en TASHO');
    }
    const p = await this.pedir(`operarios2/principalOperarios.php?TOKEN=${this.token}`);
    const m = p.html.match(RX_XTOKEN);
    if (!m) throw new Error('No se encontró el token xajax en la página de TASHO');
    this.xtoken = m[1];
    this.idOperario = (p.html.match(/saveHiddenCrumbs\(\[\],\s*(\d+)\)/) || p.html.match(/id=["']io["'][^>]*value=["'](\d+)/) || [])[1] || '1000285';
  }
  async salir() { if (this.token) { try { await this.pedir(`operarios2/salir.php?TOKEN=${this.token}`); } catch { /* da igual */ } } }
  static arg(v: unknown): string {
    if (v && typeof v === 'object') return '<xjxobj>' + Object.entries(v as Record<string, unknown>).map(([k, x]) => `<e><k>${k}</k><v>${Sesion.arg(x)}</v></e>`).join('') + '</xjxobj>';
    if (typeof v === 'number') return 'N' + v;
    if (typeof v === 'boolean') return 'B' + (v ? 'true' : 'false');
    return 'S' + String(v ?? '');
  }
  async xajax(fn: string, ...args: unknown[]) {
    const p = new URLSearchParams();
    p.append('xjxfun', fn); p.append('xjxr', String(Date.now()));
    for (const a of args) p.append('xjxargs[]', Sesion.arg(a));
    p.append('token', this.xtoken);
    const r = await this.pedir(`operarios2/principalOperarios.php?TOKEN=${this.token}&functionName=${fn}`, p.toString(), true);
    if (/^\s*TOKEN NO VALIDO/i.test(r.html)) throw new Error(`TASHO respondió «TOKEN NO VALIDO» en ${fn}`);
    // Contenido de los comandos «as» (innerHTML), sin la «S» inicial del tipo
    const trozos = [...r.html.matchAll(/<cmd cmd="as" id="([^"]*)" prop="innerHTML">(?:<!\[CDATA\[)?S?([\s\S]*?)(?:\]\]>)?<\/cmd>/g)].map((x) => ({ id: x[1], html: x[2] }));
    return { bytes: r.html.length, html: trozos.map((t) => t.html).join('\n'), trozos };
  }
  formBuscador(extra: Record<string, string>) {
    return { id_operario: this.idOperario, ultimaAperturaBuscador: '', idParte: '', idMensaje: '', nroExpediente: '', nombre: '', telefono: '', direccion: '', poblacion: '', estado_cita: '', fechaDesde: '', fechaHasta: '', ...extra };
  }
}

// ───────────────────────── lectura de las listas de citas ─────────────────────────
type Mensaje = { id: string; parte: string; texto: string; autor: string | null; fecha: string | null; de: 'tasho' | 'kubel' };
type Item = {
  parte: string; lista: 'no_informado' | 'pendiente_cita'; fecha_lista: string | null;
  campos: Record<string, string>; calle: string | null; pueblo: string | null; bandeja: string | null;
  telefonos: string[]; perjudicado: boolean; mensajes: Mensaje[];
};

function leerCitas(html: string, lista: Item['lista']): Item[] {
  // Cabeceras: data-bs-target="#collapsadorCitaNNN" … dos spans tituloPoblacion (calle+pueblo / pueblo)
  const cab = new Map<string, { calle: string; pueblo: string }>();
  for (const m of html.matchAll(/data-bs-target="#collapsadorCita(\d+)"([\s\S]*?)<\/button>/g)) {
    const spans = [...m[2].matchAll(/tituloPoblacion[^>]*>([^<]*)<\/span>/g)].map((x) => linea(x[1]));
    cab.set(m[1], { calle: spans[0] || '', pueblo: spans[1] || '' });
  }
  const items: Item[] = [];
  const cortes = [...html.matchAll(/<div id="collapsadorCita(\d+)"(?:\s+data-fecha="([^"]*)")?/g)];
  for (let i = 0; i < cortes.length; i++) {
    const c = cortes[i];
    const bloque = html.slice(c.index!, i + 1 < cortes.length ? cortes[i + 1].index! : html.length);
    const campos: Record<string, string> = {};
    let telHtml = '';
    for (const r of bloque.matchAll(/<td class="table-active titulosDatosCita[^"]*"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
      const k = linea(r[1]);
      if (!k || k in campos) continue;
      if (k === 'Teléfonos') telHtml = r[2];
      campos[k] = k === 'Trabajos' || k === 'Descripción' || k === 'Notas' ? texto(r[2]) : linea(r[2]);
    }
    if (!campos['Expediente'] && !campos['Id Exp.']) continue;
    const telefonos = [...telHtml.matchAll(/<a[^>]*>([^<]*)<\/a>/g)].map((x) => x[1].replace(/[^\d+]/g, '')).filter((t) => t.replace(/\D/g, '').length >= 9);
    const mensajes: Mensaje[] = [];
    for (const g of bloque.matchAll(/id='globoMensaje_(\d+)_(\d+)'[\s\S]*?<div class='col-12 fs-16'>([\s\S]*?)<\/div>\s*<div class='offset-5[^']*'>\s*<span class='parrafoLeidoHoraCheck[^']*'>([^<]*)</g)) {
      const pie = linea(g[4]);
      const pm = pie.match(/^(.*?)\s*(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2})\s*$/);
      const autor = pm && pm[1] ? pm[1] : null;
      mensajes.push({ id: g[1], parte: g[2], texto: texto(g[3]), autor, fecha: pm ? pm[2] : null, de: autor ? 'tasho' : 'kubel' });
    }
    const h = cab.get(c[1]);
    items.push({
      parte: c[1], lista, fecha_lista: c[2] || null, campos,
      calle: h?.calle || null, pueblo: h?.pueblo || null,
      bandeja: (bloque.match(/abrirSelectImpresoras\('[^']*',\s*'([^']*)'/) || [])[1] || null,
      telefonos, perjudicado: /perjudicado/i.test(campos['Teléfonos'] || ''), mensajes,
    });
  }
  return items;
}

// ───────────────────────── «Trabajos realizados» ─────────────────────────
type Trabajo = { idExp: string; expediente: string; fecha: string | null; precio: number | null; cantidad: number | null; total: number | null; texto: string; facturado: boolean };
function leerTrabajos(html: string, facturado: boolean): Trabajo[] {
  const out: Trabajo[] = [];
  const marcas = [...html.matchAll(/<td colspan="7" class="text-center table-dark">([^<]*)<\/td>/g)].map((m) => ({ pos: m.index!, fecha: linea(m[1]) }));
  const rx = /<tr>\s*<td class="titulosDatosCita[^"]*">\s*(\d+)\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>[\s\S]*?<\/td>\s*<td[^>]*>[\s\S]*?<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>\s*<tr>\s*<td colspan="2"[^>]*>[\s\S]*?<\/td>\s*<td colspan="5"[^>]*>([\s\S]*?)<\/td>/g;
  for (const m of html.matchAll(rx)) {
    const f = marcas.filter((x) => x.pos < m.index!).pop();
    out.push({
      idExp: m[1], expediente: linea(m[2]).replace(/^[A-Z]{1,4}\s+/, ''), fecha: f?.fecha ?? null,
      precio: num(linea(m[3])), cantidad: Number(linea(m[4])) || null, total: num(linea(m[5])), texto: texto(m[6]), facturado,
    });
  }
  return out;
}

// ───────────────────────── de items a servicios ─────────────────────────
type Servicio = {
  numero: string; idExp: string; empresa: string | null; estado: 'no_informado' | 'pendiente_cita';
  partes: Record<string, unknown>[]; datos: Record<string, unknown>; mensajes: Mensaje[]; cita: string | null;
  asegurado: string | null; direccion: string; poblacion: string | null; cp: string | null; gremio: string | null;
  descripcion: string | null; telefonos: string[]; perjudicado: boolean; numerosParte: string[];
};
function agrupar(items: Item[]): Servicio[] {
  const porParte = new Map<string, Item>();
  for (const it of items) { // un parte puede salir en las dos listas: manda «pendiente_cita»
    const prev = porParte.get(it.parte);
    if (!prev) porParte.set(it.parte, it);
    else if (it.lista === 'pendiente_cita') porParte.set(it.parte, { ...prev, ...it, campos: { ...prev.campos, ...it.campos }, mensajes: it.mensajes.length ? it.mensajes : prev.mensajes });
  }
  const grupos = new Map<string, Item[]>();
  for (const it of porParte.values()) {
    const exp = (it.campos['Expediente'] || '').trim() || 'TASHO-' + (it.campos['Id Exp.'] || it.parte);
    if (!grupos.has(exp)) grupos.set(exp, []);
    grupos.get(exp)!.push(it);
  }
  const ahora = Date.now();
  return [...grupos.entries()].map(([numero, its]) => {
    its.sort((a, b) => (ddmmaa(a.campos['Fecha'] || '') || '').localeCompare(ddmmaa(b.campos['Fecha'] || '') || ''));
    const base = its.find((x) => x.campos['Descripción']) || its[0];
    const c = base.campos;
    const dir = (c['Dirección'] || '').replace(/^perjudicado:\s*/i, '');
    const cp = (dir.match(/\((\d{5})\)/) || [])[1] || null;
    const pueblo = base.pueblo || (dir.match(/-\s*([^-]+?)\s*\(\d{5}\)/) || [])[1] || null;
    // La calle sale del campo «Dirección» (en «Pendiente cita» la cabecera trae el nº de expediente)
    let calle = (dir.split(' - ')[0] || '').trim() || (base.calle && base.calle !== numero ? base.calle : '') || dir;
    if (pueblo && calle.toUpperCase().endsWith(' ' + pueblo.toUpperCase()) && calle.length > pueblo.length + 3) calle = calle.slice(0, -pueblo.length - 1).trim();
    const trabajos = [...new Set(its.map((x) => x.campos['Trabajos']).filter(Boolean))];
    const descripcion = [c['Descripción'], trabajos.length ? 'TRABAJOS: ' + trabajos.join('\n') : ''].filter(Boolean).join('\n\n').slice(0, 4000) || null;
    const citas = its.map((x) => ddmmaa(x.campos['Fecha'] || '')).filter(Boolean) as string[];
    const futuras = citas.filter((x) => new Date(x.replace(' ', 'T') + ':00+01:00').getTime() >= ahora - 3 * 3600_000).sort();
    const mensajes = its.flatMap((x) => x.mensajes).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 40);
    return {
      numero, idExp: c['Id Exp.'] || '', empresa: c['Compañía'] || null,
      estado: its.some((x) => x.lista === 'pendiente_cita') ? 'pendiente_cita' : 'no_informado',
      partes: its.map((x) => ({
        parte: x.parte, lista: x.lista, fecha: x.campos['Fecha'] || null, tramitador: x.campos['Tramitador'] || null,
        primera_cita: x.campos['1ª Cita'] || null, especialidad: x.campos['Especialidad'] || null, bandeja: x.bandeja,
      })),
      datos: { titular: c['Titular'] || null, direccion: c['Dirección'] || null, telefonos: c['Teléfonos'] || null, descripcion: c['Descripción'] || null,
        trabajos, tramitador: c['Tramitador'] || null, empresa: c['Compañía'] || null },
      mensajes, cita: futuras[0] ?? citas.sort().pop() ?? null,
      asegurado: c['Titular'] || null, direccion: calle || '(sin dirección)', poblacion: pueblo, cp,
      gremio: its.map((x) => x.campos['Especialidad']).find((g) => g) || null,
      descripcion, telefonos: [...new Set(its.flatMap((x) => x.telefonos))], perjudicado: base.perjudicado,
      numerosParte: its.map((x) => x.parte),
    } as Servicio;
  });
}

// ───────────────────────── lectura completa ─────────────────────────
async function leerTodo(ses: Sesion) {
  await ses.xajax('buscadorV2', []);
  const n = await ses.xajax('buscarV2', ses.formBuscador({ estado_cita: 'N' }), true);
  const noInf = leerCitas(n.html, 'no_informado');
  const total = (n.trozos.find((t) => t.id === 'totalResultados')?.html.match(/(\d+)/) || [])[1];
  const pc = await ses.xajax('listarPartesCitadosV2', { fecha: '', fecha2: '', idParte: '', aplicacion: 'confirmarCita' });
  const pend = leerCitas(pc.html, 'pendiente_cita');
  // Trabajos realizados de los últimos 120 días (facturados y no facturados)
  const hasta = hoyMadrid(); const desde = new Date(hasta.getTime() - 120 * 86400_000);
  const trabajos: Trabajo[] = [];
  await ses.xajax('cargarTrabajosRealizadosV2', []);
  for (const fac of ['noFacturado', 'facturado']) {
    const t = await ses.xajax('buscarTrabajosRealizadosV2', { id_operario: ses.idOperario, ultimaAperturaBuscador: '', empresa: 'todas', fechaDesde: fmt(desde), fechaHasta: fmt(hasta), facturado: fac, realizados: 'none' }, true);
    trabajos.push(...leerTrabajos(t.html, fac === 'facturado'));
  }
  return { noInf, pend, trabajos, bytesN: n.bytes, totalN: total ? Number(total) : null, bytesPend: pc.bytes };
}

// Comprueba si un expediente desaparecido está informado (buscador estado V por Id Exp.)
async function estaInformado(ses: Sesion, idExp: string) {
  const r = await ses.xajax('buscarV2', ses.formBuscador({ idMensaje: idExp, estado_cita: 'V' }), true);
  return leerCitas(r.html, 'no_informado').some((x) => x.campos['Id Exp.'] === idExp);
}

// ───────────────────────── escritura en KUBEL ─────────────────────────
async function volcar(ses: Sesion, lect: Awaited<ReturnType<typeof leerTodo>>, inicio: number) {
  const servicios = agrupar([...lect.noInf, ...lect.pend]);
  const resumen: Record<string, unknown> = { leidos_no_informados: lect.noInf.length, leidos_pendiente_cita: lect.pend.length, total_portal_N: lect.totalN, expedientes: servicios.length, trabajos: lect.trabajos.length };
  const nuevos: string[] = [], adoptados: string[] = [], reabiertos: string[] = [], cerrados: string[] = [], anulados: string[] = [], avisos: string[] = [];
  const porIdExp = new Map<string, Trabajo[]>();
  for (const t of lect.trabajos) { if (!porIdExp.has(t.idExp)) porIdExp.set(t.idExp, []); porIdExp.get(t.idExp)!.push(t); }

  const sql = sqlDb();
  try {
    for (const s of servicios) {
      // ¿ya existe? por nº de expediente, por Id Exp. o (alta manual) por nº de Id Exp. / Parte
      const cand = [s.numero, s.idExp, ...s.numerosParte].filter(Boolean);
      const filas = await sql`
        select id, numero_servicio, origen, estado, tasho_cierre
          from public.partes
         where compania_id = ${COMPANIA}
           and (numero_servicio = any(${cand}) or (tasho_id_exp is not null and tasho_id_exp = ${s.idExp || '-'}))
         order by (numero_servicio = ${s.numero}) desc, (origen = 'tasho') desc, creado_en`;
      const tels = s.telefonos;
      const t1 = s.perjudicado ? null : tels[0] ?? null, t2 = s.perjudicado ? null : tels[1] ?? null;
      const p1 = s.perjudicado ? tels[0] ?? null : null, p2 = s.perjudicado ? tels[1] ?? null : null;
      const comunes = {
        tasho_id_exp: s.idExp || null, tasho_empresa: s.empresa, tasho_estado: s.estado,
        tasho_partes: sql.json(s.partes), tasho_mensajes: sql.json(s.mensajes),
        tasho_visto_en: new Date(), tasho_comprobado_en: new Date(), tasho_pedir: false,
      };
      if (!filas.length) {
        const [n] = await sql`
          insert into public.partes ${sql({
            compania_id: COMPANIA, numero_servicio: s.numero, origen: 'tasho', estado: 'pendiente',
            asegurado: s.asegurado, direccion: s.direccion, poblacion: s.poblacion, codigo_postal: s.cp, gremio: s.gremio,
            descripcion: s.descripcion, aseguradora: s.empresa, telefono: t1, telefono2: t2, telefono_perjudicado: p1, telefono_perjudicado2: p2,
          })}
          on conflict (compania_id, numero_servicio) do nothing returning id`;
        if (n) {
          await sql`update public.partes set ${sql(comunes)},
              tasho_datos = ${sql.json({ ...s.datos, _desc: s.descripcion })},
              tasho_cita = ${s.cita}::timestamp at time zone 'Europe/Madrid'
            where id = ${n.id}`;
          nuevos.push(s.numero);
        }
        continue;
      }
      const f = filas[0];
      if (filas.length > 1) avisos.push(`${s.numero}: encajan ${filas.length} servicios de TASHO (${filas.map((x) => x.numero_servicio).join(', ')}); se usa ${f.numero_servicio}`);
      const adoptar = f.origen !== 'tasho';
      const cambiarNumero = f.numero_servicio !== s.numero && !filas.some((x) => x.numero_servicio === s.numero && x.id !== f.id);
      const cierre = f.tasho_cierre as { auto?: boolean; estado_antes?: string } | null;
      const reabrir = (f.estado === 'cerrado' || f.estado === 'anulado') && !!cierre?.auto;
      // La descripción solo se rehace si la oficina no la ha cambiado (se compara con la última que puso el robot)
      const [d] = await sql`
        update public.partes set ${sql(comunes)},
          tasho_cita = ${s.cita}::timestamp at time zone 'Europe/Madrid',
          origen = 'tasho',
          numero_servicio = ${cambiarNumero ? s.numero : f.numero_servicio},
          asegurado = coalesce(asegurado, ${s.asegurado}),
          poblacion = coalesce(poblacion, ${s.poblacion}),
          codigo_postal = coalesce(codigo_postal, ${s.cp}),
          gremio = coalesce(gremio, ${s.gremio}),
          aseguradora = coalesce(aseguradora, ${s.empresa}),
          descripcion = case when descripcion is null then ${s.descripcion}
                             when ${!adoptar} and descripcion is not distinct from (tasho_datos->>'_desc') then ${s.descripcion}
                             else descripcion end,
          telefono = coalesce(telefono, ${t1}), telefono2 = coalesce(telefono2, ${t2}),
          telefono_perjudicado = coalesce(telefono_perjudicado, ${p1}), telefono_perjudicado2 = coalesce(telefono_perjudicado2, ${p2}),
          estado = case when ${reabrir} then coalesce(${cierre?.estado_antes ?? null}::text, 'pendiente') else estado end,
          tasho_cierre = case when ${reabrir} then null else tasho_cierre end
        where id = ${f.id}
        returning descripcion`;
      await sql`update public.partes set tasho_datos = ${sql.json({ ...s.datos, _desc: d?.descripcion ?? null })} where id = ${f.id}`;
      if (adoptar) adoptados.push(`${f.numero_servicio} → ${cambiarNumero ? s.numero : f.numero_servicio}`);
      if (reabrir) reabiertos.push(s.numero);
    }

    // Importes de «Trabajos realizados» (también de servicios ya cerrados)
    let importes = 0;
    for (const [idExp, ts] of porIdExp) {
      const total = Math.round(ts.reduce((a, t) => a + (t.total ?? 0), 0) * 100) / 100;
      const lineas = ts.map((t) => ({ fecha: t.fecha, texto: t.texto, precio: t.precio, cantidad: t.cantidad, total: t.total, facturado: t.facturado }));
      const r = await sql`
        update public.partes set tasho_importe = ${total}, tasho_trabajos = ${sql.json(lineas)}
         where compania_id = ${COMPANIA} and origen = 'tasho' and (tasho_id_exp = ${idExp} or numero_servicio = ${ts[0].expediente})
           and (tasho_importe is distinct from ${total} or tasho_trabajos is null or tasho_trabajos <> ${sql.json(lineas)}::jsonb)`;
      importes += r.count;
    }
    resumen.importes_actualizados = importes;

    // Cierres: abiertos de TASHO que no han salido en esta pasada
    const fiable = lect.noInf.length > 0 && lect.bytesN > 2000 && (lect.totalN == null || lect.totalN === lect.noInf.length);
    if (!fiable) avisos.push(`Sin cierres en esta pasada: la lista de no informados no parece completa (${lect.noInf.length} leídos de ${lect.totalN ?? '?'})`);
    else {
      const vistos = servicios.map((s) => s.numero);
      const desaparecidos = await sql`
        select id, numero_servicio, estado, tasho_id_exp from public.partes
         where compania_id = ${COMPANIA} and origen = 'tasho' and estado not in ('cerrado', 'anulado')
           and not (numero_servicio = any(${vistos}))
         order by tasho_pedir desc, tasho_comprobado_en nulls first limit ${MAX_COMPROBAR}`;
      for (const d of desaparecidos) {
        if (Date.now() - inicio > TOPE_MS) { avisos.push('Tope de tiempo: quedan cierres por comprobar'); break; }
        let informado = !!(d.tasho_id_exp && porIdExp.has(d.tasho_id_exp));
        if (!informado && d.tasho_id_exp) informado = await estaInformado(ses, d.tasho_id_exp);
        const motivo = informado ? 'Informado en TASHO' : 'Ya no aparece en TASHO (retirado o pasado a otro operario)';
        await sql`
          update public.partes set estado = ${informado ? 'cerrado' : 'anulado'},
            tasho_estado = ${informado ? 'informado' : 'retirado'},
            tasho_cierre = ${sql.json({ auto: true, motivo, en: new Date().toISOString(), estado_antes: d.estado })},
            tasho_pedir = false, tasho_comprobado_en = now()
          where id = ${d.id}`;
        (informado ? cerrados : anulados).push(d.numero_servicio);
      }
      await sql`update public.partes set tasho_pedir = false, tasho_comprobado_en = now() where compania_id = ${COMPANIA} and tasho_pedir`;
    }
  } finally { await sql.end(); }
  Object.assign(resumen, { nuevos, adoptados, reabiertos, cerrados, anulados, avisos });
  return resumen;
}

async function registrar(ok: boolean, resumen: unknown, error: string | undefined, inicio: Date) {
  const sql = sqlDb();
  try {
    await sql`insert into public.tasho_sincronizaciones (inicio, fin, ok, resumen, error) values (${inicio}, now(), ${ok}, ${sql.json((resumen ?? {}) as Record<string, unknown>)}, ${error ?? null})`;
  } finally { await sql.end(); }
}

// ───────────────────────── entrada ─────────────────────────
const LECTURAS = /^(listarPartesCitadosV2|abrirParteV2|buscarV2|buscadorV2|listarCaducadosV2|verHistorialV2|mostrarMenuCaducados|cargarTrabajosRealizadosV2|buscarTrabajosRealizadosV2|cargarMenuPrincipalV2|verInformesAnterioresV2)$/;

Deno.serve(async (req) => {
  const s = await leerSecreto();
  if (!s || req.headers.get('x-kubel-secreto') !== s) return new Response('no', { status: 401 });
  const json = (o: unknown) => new Response(JSON.stringify(o, null, 1), { headers: { 'Content-Type': 'application/json' } });
  const usuario = Deno.env.get('TASHO_USUARIO')?.trim(), clave = Deno.env.get('TASHO_CLAVE')?.trim();
  if (!usuario || !clave) return json({ ok: false, error: 'Faltan TASHO_USUARIO / TASHO_CLAVE en los secretos' });
  const q = new URL(req.url).searchParams;
  const ses = new Sesion();
  const inicio = Date.now(); const inicioD = new Date();
  try {
    await ses.entrar(usuario, clave);
    if (q.get('sesiones') === '1') { // ¿TASHO admite dos sesiones a la vez con el mismo usuario?
      const otra = new Sesion();
      await otra.entrar(usuario, clave);
      let primera = 'sigue viva';
      try { const r = await ses.xajax('cargarMenuPrincipalV2', []); if (!/CITAS/i.test(texto(r.html))) primera = 'responde sin datos (' + r.bytes + ' bytes)'; }
      catch (e) { primera = 'cerrada: ' + (e as Error).message; }
      await otra.salir();
      return json({ ok: true, prueba_sesiones: primera, pasos_primera: ses.pasos.slice(-3) });
    }
    const fn = q.get('fn');
    if (fn) { // diagnóstico de una lectura concreta (nunca escribe)
      if (!LECTURAS.test(fn)) return json({ ok: false, error: 'Función no permitida (solo lecturas)' });
      const pre = q.get('pre'); if (pre && LECTURAS.test(pre)) await ses.xajax(pre, []);
      const a = JSON.parse(q.get('args') || '{}');
      const r = await ses.xajax(fn, ...(Array.isArray(a) ? a : [a]));
      const d = Number(q.get('desde') || 0);
      return json({ ok: true, fn, bytes: r.bytes, texto: texto(r.html).slice(0, Number(q.get('max') || 4000)), html: q.get('html') === '1' ? r.html.slice(d, d + 20000) : undefined });
    }
    const lect = await leerTodo(ses);
    if (q.get('prueba') === '1') {
      const servicios = agrupar([...lect.noInf, ...lect.pend]);
      return json({ ok: true, prueba: true, totalN: lect.totalN, leidosN: lect.noInf.length, leidosPend: lect.pend.length, trabajos: lect.trabajos.length,
        servicios: servicios.map((x) => ({ ...x, mensajes: x.mensajes.length, ultimo_mensaje: x.mensajes[0], datos: undefined })).slice(0, Number(q.get('n') || 60)),
        trabajos_ej: lect.trabajos.slice(0, 5), segundos: Math.round((Date.now() - inicio) / 1000) });
    }
    const resumen = await volcar(ses, lect, inicio);
    resumen.segundos = Math.round((Date.now() - inicio) / 1000);
    await registrar(true, resumen, undefined, inicioD);
    return json({ ok: true, ...resumen });
  } catch (e) {
    const msg = (e as Error).message;
    try { await registrar(false, { pasos: ses.pasos.slice(-12) }, msg, inicioD); } catch { /* nada */ }
    return json({ ok: false, error: msg, pasos: ses.pasos.slice(-12) });
  } finally { await ses.salir(); }
});
