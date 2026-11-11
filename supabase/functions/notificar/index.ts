// KUBEL — envía notificaciones push a los móviles.
// La llama la base de datos (disparadores en asignaciones e informes), el robot SIGMA y onred-recibir, con una cabecera secreta.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';
import postgres from 'npm:postgres@3.4.4';

const BASE = 'https://kubelapp.github.io';
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

let ajustes: Record<string, string> | null = null;
async function leerAjustes() {
  if (ajustes) return ajustes;
  const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });
  try {
    const filas = await sql`select clave, valor from privado.ajustes`;
    ajustes = Object.fromEntries(filas.map((f) => [f.clave, f.valor]));
  } finally {
    await sql.end();
  }
  return ajustes!;
}

function hoyMadrid(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
}
function cuando(fecha: string, hora: string | null): string {
  const [a, m, d] = fecha.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  const h = hoyMadrid();
  const dif = Math.round((f.getTime() - new Date(h + 'T00:00:00Z').getTime()) / 86400000);
  const rel = dif === 0 ? 'Hoy' : dif === 1 ? 'Mañana' : `${DIAS[f.getUTCDay()]} ${d} ${MESES[m - 1]}`;
  return hora ? `${rel} a las ${hora.slice(0, 5)}` : rel;
}

type NuevoSigma = { numero: string; direccion: string; gremio: string; urgente: boolean };

Deno.serve(async (req) => {
  try {
    const aj = await leerAjustes();
    if (req.headers.get('x-kubel-secreto') !== aj.notif_secreto) return new Response('no', { status: 401 });
    webpush.setVapidDetails(BASE, aj.vapid_public, aj.vapid_private);
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

    const { tabla, evento, nuevo, viejo } = await req.json();
    const envios: { a: string[]; titulo: string; texto: string; url: string; tag: string }[] = [];

    const parteDe = async (id: string) =>
      (await admin.from('partes').select('numero_servicio, direccion, poblacion').eq('id', id).single()).data;
    const nombreDe = async (id: string) =>
      (await admin.from('perfiles').select('nombre').eq('id', id).single()).data?.nombre || 'Operario';
    const oficina = async () =>
      ((await admin.from('perfiles').select('id').eq('rol', 'oficina').eq('activo', true)).data || []).map((x) => x.id);
    const dir = (p: { direccion?: string; poblacion?: string } | null) => [p?.direccion, p?.poblacion].filter(Boolean).join(', ');

    if (tabla === 'asignaciones') {
      const p = await parteDe(nuevo.parte_id);
      const resumen = `${p?.numero_servicio ?? ''} · ${dir(p)}`;
      if (evento === 'INSERT') {
        envios.push({ a: [nuevo.operario_id], titulo: `Nuevo servicio · ${cuando(nuevo.fecha, nuevo.hora)}`, texto: resumen, url: `${BASE}/operario/`, tag: 'asig-' + nuevo.id });
      } else if (evento === 'UPDATE') {
        if (viejo.operario_id !== nuevo.operario_id) {
          envios.push({ a: [nuevo.operario_id], titulo: `Nuevo servicio · ${cuando(nuevo.fecha, nuevo.hora)}`, texto: resumen, url: `${BASE}/operario/`, tag: 'asig-' + nuevo.id });
          envios.push({ a: [viejo.operario_id], titulo: 'Servicio retirado', texto: `${resumen} ya no está en tu ruta`, url: `${BASE}/operario/`, tag: 'asig-' + nuevo.id });
        } else if (viejo.fecha !== nuevo.fecha || viejo.hora !== nuevo.hora) {
          envios.push({ a: [nuevo.operario_id], titulo: `Servicio cambiado · ahora ${cuando(nuevo.fecha, nuevo.hora)}`, texto: resumen, url: `${BASE}/operario/`, tag: 'asig-' + nuevo.id });
        }
        if (nuevo.estado === 'no_realizado' && viejo.estado !== 'no_realizado') {
          envios.push({ a: await oficina(), titulo: `⚠️ No realizado · ${await nombreDe(nuevo.operario_id)}`, texto: resumen, url: `${BASE}/oficina/#hoy`, tag: 'nr-' + nuevo.id });
        }
      }
    } else if (tabla === 'informes' && evento === 'INSERT') {
      const p = await parteDe(nuevo.parte_id);
      const extra = [nuevo.trabajo_terminado ? 'Terminado' : 'Sin terminar', nuevo.necesita_repaso ? 'necesita repaso' : '', nuevo.importe_gastos ? `gastos ${Number(nuevo.importe_gastos).toFixed(2).replace('.', ',')} €` : '']
        .filter(Boolean).join(' · ');
      envios.push({ a: await oficina(), titulo: `📝 Informe de ${await nombreDe(nuevo.operario_id)}`, texto: `${p?.numero_servicio ?? ''} · ${extra}`, url: `${BASE}/oficina/#informes`, tag: 'inf-' + nuevo.id });
    } else if (tabla === 'sigma' && evento === 'resumen') {
      // Resumen de una pasada del robot SIGMA (solo a la oficina)
      const a = await oficina();
      const momento = Date.now();
      const acep: { numero: string; gremio: string; domicilio: string }[] = nuevo.aceptados || [];
      if (acep.length) {
        envios.push({
          a, titulo: `✅ ${acep.length === 1 ? 'Aceptado 1 servicio ofrecido' : `Aceptados ${acep.length} servicios ofrecidos`} · SIGMA ${nuevo.nombre}`,
          texto: acep.slice(0, 3).map((x) => [x.numero, x.gremio, x.domicilio].filter(Boolean).join(' ')).join(' · ') + (acep.length > 3 ? ' …' : ''),
          url: `${BASE}/oficina/#partes`, tag: 'sigma-acep-' + momento,
        });
      }
      if (nuevo.error) {
        envios.push({ a, titulo: `⚠️ SIGMA ${nuevo.nombre}: la sincronización falla`, texto: nuevo.error, url: `${BASE}/oficina/`, tag: 'sigma-error-' + nuevo.cuenta });
      }
      {
        const nuevos: NuevoSigma[] = nuevo.nuevos || [];
        if (nuevos.length === 1) {
          const n = nuevos[0];
          envios.push({ a, titulo: `📥 Nuevo servicio SIGMA ${nuevo.nombre}${n.urgente ? ' · URGENTE' : ''}`, texto: [n.numero, n.gremio, n.direccion].filter(Boolean).join(' · '), url: `${BASE}/oficina/#partes`, tag: 'sigma-nuevo-' + n.numero });
        } else if (nuevos.length > 1) {
          const urg = nuevos.filter((n) => n.urgente).length;
          envios.push({
            a, titulo: `📥 ${nuevos.length} servicios nuevos SIGMA ${nuevo.nombre}${urg ? ` (${urg} urgente${urg > 1 ? 's' : ''})` : ''}`,
            texto: nuevos.slice(0, 3).map((n) => `${n.numero} ${n.gremio}`).join(' · ') + (nuevos.length > 3 ? ' …' : ''),
            url: `${BASE}/oficina/#partes`, tag: 'sigma-nuevos-' + momento,
          });
        }
        const fuera: string[] = nuevo.desaparecidos || [];
        if (fuera.length) {
          envios.push({
            a, titulo: `SIGMA ${nuevo.nombre}: ${fuera.length === 1 ? '1 servicio ya no está' : `${fuera.length} servicios ya no están`} en curso`,
            texto: fuera.slice(0, 5).join(', ') + (fuera.length > 5 ? ' …' : ''), url: `${BASE}/oficina/#partes`, tag: 'sigma-fuera-' + momento,
          });
        }
      }
    } else if (tabla === 'onred' && evento === 'resumen') {
      // Pasada del lector de ONRED (onred-recibir, SQL 42): servicios nuevos, cerrados por ONRED o fallo del lector
      const a = await oficina();
      const momento = Date.now();
      if (nuevo.error) envios.push({ a, titulo: '⚠️ ONRED: el lector falla', texto: nuevo.error, url: `${BASE}/oficina/`, tag: 'onred-error' });
      const nuevos: NuevoSigma[] = nuevo.nuevos || [];
      if (nuevos.length === 1) {
        const n = nuevos[0];
        envios.push({ a, titulo: `📥 Nuevo servicio ONRED${n.urgente ? ' · URGENTE' : ''}`, texto: [n.numero, n.gremio, n.direccion].filter(Boolean).join(' · '), url: `${BASE}/oficina/#partes`, tag: 'onred-nuevo-' + n.numero });
      } else if (nuevos.length > 1) {
        const urg = nuevos.filter((n) => n.urgente).length;
        envios.push({
          a, titulo: `📥 ${nuevos.length} servicios nuevos ONRED${urg ? ` (${urg} urgente${urg > 1 ? 's' : ''})` : ''}`,
          texto: nuevos.slice(0, 3).map((n) => `${n.numero} ${n.gremio}`).join(' · ') + (nuevos.length > 3 ? ' …' : ''),
          url: `${BASE}/oficina/#partes`, tag: 'onred-nuevos-' + momento,
        });
      }
      const cer: { numero: string; estado: string }[] = nuevo.cerrados || [];
      if (cer.length) {
        envios.push({
          a, titulo: `ONRED: ${cer.length === 1 ? '1 servicio cerrado' : `${cer.length} servicios cerrados`}`,
          texto: cer.slice(0, 5).map((c) => c.numero + (c.estado === 'anulado' ? ' (anulado)' : '')).join(', ') + (cer.length > 5 ? ' …' : ''),
          url: `${BASE}/oficina/#partes`, tag: 'onred-cerrados-' + momento,
        });
      }
    }

    let enviados = 0;
    for (const e of envios) {
      const ids = e.a.filter(Boolean);
      if (!ids.length) continue;
      const { data: subs } = await admin.from('push_suscripciones').select('id, endpoint, p256dh, auth').in('usuario_id', ids);
      const carga = JSON.stringify({ title: e.titulo, body: e.texto, url: e.url, tag: e.tag });
      await Promise.all((subs || []).map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, carga, { TTL: 86400, urgency: 'high' });
          enviados++;
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) await admin.from('push_suscripciones').delete().eq('id', s.id); // móvil dado de baja
          else console.error('push', code, (err as Error).message);
        }
      }));
    }
    return new Response(JSON.stringify({ ok: true, enviados }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
