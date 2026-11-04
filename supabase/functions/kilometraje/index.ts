// KUBEL — Robot de KILOMETRAJE (04/11/2026) · panel admin → «Kilometraje»
// Por cada operario y día marcado en km_pendientes (lo marcan los disparadores al tocar Planificación):
//   Valladolid (km 0) → pueblos de las visitas del día, en orden (hora, orden) → vuelta a Valladolid.
// · Por PUEBLO, no por dirección: dos visitas seguidas en el mismo pueblo (también Valladolid capital) = 0 km.
// · Pueblo = población del servicio sin el código postal, sin tildes ni signos; provincia por el CP (47 / 34).
//   Si falta la población, o el mapa sitúa el nombre a más de 20 km de su código postal (barrios, urbanizaciones:
//   «BOMBA», «PINAR DEL PEREGRINO»…), se usa el centro del código postal. Sin población ni CP → «sin ubicar».
// · Coordenadas: Nominatim (OpenStreetMap), máx. 1 consulta por segundo. Distancia por carretera: OSRM.
//   Todo se guarda (km_lugares, km_distancias): cada pueblo y cada tramo se consulta una sola vez.
// · Cuentan todas las visitas planificadas del día (pendiente, hecho y no realizado).
// · Precio por km de km_tarifas (operario o '*'); se guarda en la línea. Nunca pisa km_manual ni comentario.
// Lo llama pg_cron cada 5 min (solo si hay días pendientes) con la cabecera secreta x-kubel-secreto.
// ?prueba=1 → calcula y devuelve el resultado sin escribir en kilometraje ni vaciar pendientes.
import postgres from 'npm:postgres@3.4.4';

const UA = 'KUBEL-kilometraje/1.0 (+https://kubelapp.github.io)';
const TOPE_MS = 110_000;
const ORIGEN = 'VALLADOLID|47';
const MAX_DIAS = 400;
let INICIO = Date.now();
const tiempo = () => Date.now() - INICIO < TOPE_MS;
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Lugar = { clave: string; nombre: string; provincia: string | null; lat: number | null; lon: number | null; origen: string };
type Parada = { clave: string | null; nombre: string; cp: string | null };

const PROV: Record<string, string> = { '47': 'Valladolid', '34': 'Palencia', '49': 'Zamora', '37': 'Salamanca', '05': 'Ávila', '40': 'Segovia', '09': 'Burgos', '24': 'León', '42': 'Soria' };
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
  .replace(/\d+/g, ' ').replace(/[^A-Z]+/g, ' ').replace(/\s+/g, ' ').trim();
const titulo = (s: string) => s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, a, b) => a + b.toUpperCase())
  .replace(/\s(De|Del|La|Las|Los|El|Y)\b/g, (m) => m.toLowerCase());

// Pueblo de una visita → clave
function parada(poblacion: string | null, cp: string | null): Parada {
  cp = (cp || '').trim() || ((poblacion || '').match(/\b\d{5}\b/)?.[0] ?? null);
  const pref = cp ? cp.slice(0, 2) : null;
  let n = norm(poblacion || '');
  if (!n && cp && /^470(0\d|1[0-7])$/.test(cp)) n = 'VALLADOLID';
  if (!n && cp && /^340(0\d)$/.test(cp)) n = 'PALENCIA';
  if (n === 'VALLADOLID') return { clave: 'VALLADOLID|47', nombre: 'Valladolid', cp };
  if (n === 'PALENCIA') return { clave: 'PALENCIA|34', nombre: 'Palencia', cp };
  if (n) return { clave: `${n}|${pref ?? ''}`, nombre: titulo(n), cp };
  if (cp) return { clave: `CP|${cp}`, nombre: `CP ${cp}`, cp };
  return { clave: null, nombre: 'Sin pueblo', cp: null };
}

// ---------------------------------------------------------------- mapas
let ultimaNom = 0;
async function nominatim(params: Record<string, string>) {
  const pausa = 1100 - (Date.now() - ultimaNom);
  if (pausa > 0) await espera(pausa);
  ultimaNom = Date.now();
  const u = new URL('https://nominatim.openstreetmap.org/search');
  Object.entries({ format: 'json', limit: '5', countrycodes: 'es', 'accept-language': 'es', ...params }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Nominatim ${r.status}`);
  return (await r.json()) as { lat: string; lon: string; display_name: string; class: string; type: string; addresstype?: string }[];
}
function kmLinea(a: [number, number], b: [number, number]) {
  const R = 6371, r = Math.PI / 180;
  const dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const POBLADO = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'quarter', 'isolated_dwelling', 'locality', 'municipality', 'residential']);

async function geolocalizar(p: Parada): Promise<Lugar> {
  const [nombreClave, pref] = p.clave!.split('|');
  const provincia = pref && PROV[pref] ? PROV[pref] : null;
  let centroCP: [number, number] | null = null;
  if (p.cp) {
    const r = await nominatim({ postalcode: p.cp, country: 'España' });
    if (r[0]) centroCP = [+r[0].lat, +r[0].lon];
  }
  if (nombreClave !== 'CP') {
    const q = `${titulo(nombreClave)}, ${provincia ?? 'Castilla y León'}, España`;
    const res = await nominatim({ q });
    const buenos = res.filter((x) => POBLADO.has(x.addresstype || '') || POBLADO.has(x.type) || x.class === 'place' || x.class === 'boundary');
    for (const x of buenos.length ? buenos : res) {
      const c: [number, number] = [+x.lat, +x.lon];
      if (centroCP && kmLinea(c, centroCP) > 20) continue; // el nombre no cuadra con su código postal
      return { clave: p.clave!, nombre: p.nombre, provincia, lat: c[0], lon: c[1], origen: 'nombre', encontrado: x.display_name } as Lugar & { encontrado: string };
    }
  }
  if (centroCP) return { clave: p.clave!, nombre: p.nombre, provincia, lat: centroCP[0], lon: centroCP[1], origen: 'cp', encontrado: `Código postal ${p.cp}` } as Lugar & { encontrado: string };
  return { clave: p.clave!, nombre: p.nombre, provincia, lat: null, lon: null, origen: 'no_encontrado', encontrado: null } as unknown as Lugar;
}

async function carretera(a: Lugar, b: Lugar): Promise<number> {
  const u = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    if (r.ok) {
      const j = await r.json();
      if (j.code === 'Ok' && j.routes?.[0]) return Math.round(j.routes[0].distance / 100) / 10;
    }
    await espera(1500);
  }
  throw new Error(`OSRM sin ruta ${a.clave} → ${b.clave}`);
}

// ---------------------------------------------------------------- principal
Deno.serve(async (req) => {
  INICIO = Date.now();
  const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });
  try {
    const [s] = await sql`select valor from privado.ajustes where clave = 'notif_secreto'`;
    if (!s?.valor || req.headers.get('x-kubel-secreto') !== s.valor) return new Response('no', { status: 401 });
    const prueba = new URL(req.url).searchParams.get('prueba') === '1';

    const pend = await sql`select operario_id, fecha::text as fecha, marcado_en from km_pendientes order by fecha desc limit ${MAX_DIAS}`;
    if (!pend.length) return new Response(JSON.stringify({ dias: 0 }), { headers: { 'Content-Type': 'application/json' } });

    const visitas = await sql`
      select a.operario_id, a.fecha::text as fecha, a.hora::text as hora, a.orden, p.numero_servicio as numero, p.poblacion, p.codigo_postal
      from asignaciones a join partes p on p.id = a.parte_id
      join km_pendientes k on k.operario_id = a.operario_id and k.fecha = a.fecha
      order by a.fecha, a.hora nulls last, a.orden nulls last, a.creado_en`;
    const nombres = new Map((await sql`select id, nombre from perfiles`).map((x) => [x.id, x.nombre]));
    const tarifas = new Map((await sql`select clave, euros_km from km_tarifas`).map((x) => [x.clave, Number(x.euros_km)]));
    const lugares = new Map<string, Lugar>((await sql`select * from km_lugares`).map((x) => [x.clave, x as unknown as Lugar]));
    const dist = new Map<string, number>((await sql`select a, b, km from km_distancias`).map((x) => [`${x.a}§${x.b}`, Number(x.km)]));

    const porDia = new Map<string, typeof visitas>();
    for (const v of visitas) {
      const k = `${v.operario_id}§${v.fecha}`;
      if (!porDia.has(k)) porDia.set(k, [] as unknown as typeof visitas);
      porDia.get(k)!.push(v);
    }

    const lugar = async (p: Parada): Promise<Lugar | null> => {
      if (lugares.has(p.clave!)) return lugares.get(p.clave!)!;
      if (!tiempo()) return null;
      const l = await geolocalizar(p) as Lugar & { encontrado?: string };
      lugares.set(l.clave, l);
      if (!prueba) await sql`insert into km_lugares (clave, nombre, provincia, lat, lon, encontrado, origen)
        values (${l.clave}, ${l.nombre}, ${l.provincia}, ${l.lat}, ${l.lon}, ${l.encontrado ?? null}, ${l.origen})
        on conflict (clave) do nothing`;
      return l;
    };
    const tramo = async (a: Lugar, b: Lugar): Promise<number | null> => {
      if (a.clave === b.clave) return 0;
      const [x, y] = a.clave < b.clave ? [a, b] : [b, a];
      const k = `${x.clave}§${y.clave}`;
      if (dist.has(k)) return dist.get(k)!;
      if (!tiempo()) return null;
      const km = await carretera(x, y);
      dist.set(k, km);
      if (!prueba) await sql`insert into km_distancias (a, b, km) values (${x.clave}, ${y.clave}, ${km}) on conflict (a, b) do update set km = excluded.km, calculado_en = now()`;
      return km;
    };

    const origen = await lugar({ clave: ORIGEN, nombre: 'Valladolid', cp: '47001' });
    if (!origen?.lat) throw new Error('No se pudo situar Valladolid');

    const hechos: unknown[] = [];
    let quedan = 0;
    for (const d of pend) {
      if (!tiempo()) { quedan++; continue; }
      const lista = porDia.get(`${d.operario_id}§${d.fecha}`) ?? [];
      if (!lista.length) {
        if (!prueba) await sql`delete from kilometraje where operario_id = ${d.operario_id} and fecha = ${d.fecha} and km_manual is null and coalesce(comentario, '') = ''`;
        if (!prueba) await sql`delete from km_pendientes where operario_id = ${d.operario_id} and fecha = ${d.fecha} and marcado_en <= ${d.marcado_en}`;
        hechos.push({ fecha: d.fecha, operario: nombres.get(d.operario_id), visitas: 0 });
        continue;
      }
      // Paradas en orden (pueblos seguidos iguales = una sola)
      const camino: { l: Lugar; servicios: string[] }[] = [{ l: origen, servicios: [] }];
      let sinUbicar = 0, cortado = false;
      for (const v of lista) {
        const p = parada(v.poblacion, v.codigo_postal);
        if (!p.clave) { sinUbicar++; continue; }
        const l = await lugar(p);
        if (!l) { cortado = true; break; }
        if (l.lat == null) { sinUbicar++; continue; }
        const ult = camino[camino.length - 1];
        if (ult.l.clave === l.clave) ult.servicios.push(v.numero);
        else camino.push({ l, servicios: [v.numero] });
      }
      if (cortado) { quedan++; continue; }
      camino.push({ l: origen, servicios: [] }); // vuelta a Valladolid
      const ruta: { de: string; a: string; km: number; servicios?: string[] }[] = [];
      let total = 0;
      for (let i = 1; i < camino.length; i++) {
        if (camino[i - 1].l.clave === camino[i].l.clave) continue; // ya estaba en Valladolid
        const km = await tramo(camino[i - 1].l, camino[i].l);
        if (km == null) { cortado = true; break; }
        total += km;
        ruta.push({ de: camino[i - 1].l.nombre, a: camino[i].l.nombre, km, servicios: camino[i].servicios.length ? camino[i].servicios : undefined });
      }
      if (cortado) { quedan++; continue; }
      total = Math.round(total * 10) / 10;
      const tarifa = tarifas.get(String(d.operario_id)) ?? tarifas.get('*') ?? 0.2;
      const op = nombres.get(d.operario_id) ?? null;
      hechos.push({ fecha: d.fecha, operario: op, visitas: lista.length, km: total, ruta: ruta.map((r) => `${r.de}→${r.a} ${r.km}`).join(' · ') });
      if (!prueba) {
        await sql`insert into kilometraje (operario_id, fecha, operario, visitas, ruta, km, tarifa, sin_ubicar, calculado_en)
          values (${d.operario_id}, ${d.fecha}, ${op}, ${lista.length}, ${sql.json(ruta)}, ${total}, ${tarifa}, ${sinUbicar}, now())
          on conflict (operario_id, fecha) do update set operario = excluded.operario, visitas = excluded.visitas, ruta = excluded.ruta,
            km = excluded.km, tarifa = excluded.tarifa, sin_ubicar = excluded.sin_ubicar, calculado_en = now()`;
        await sql`delete from km_pendientes where operario_id = ${d.operario_id} and fecha = ${d.fecha} and marcado_en <= ${d.marcado_en}`;
      }
    }
    const res = { prueba, dias: pend.length, calculados: hechos.length, quedan, segundos: Math.round((Date.now() - INICIO) / 1000), hechos: prueba ? hechos : undefined };
    console.log('kilometraje', JSON.stringify({ ...res, hechos: undefined }));
    return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  } finally {
    await sql.end();
  }
});
