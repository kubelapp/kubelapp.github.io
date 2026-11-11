// KUBEL — onred-recibir (v2, 11/11/2026). v2: vuelca en Servicios (privado.onred_volcar, SQL 42), pide también las
// fichas de los servicios OnRed abiertos que ya no salen en las listas (para cerrarlos) y avisa a la oficina.
// v1: Recibe del «lector» del servidor kubel-onred (Clouding, Barcelona)
// las páginas de ONRED que KUBEL no puede descargar (ONRED solo admite conexiones desde España),
// las analiza y las guarda en onred_servicios / onred_lecturas (SQL 41). Nunca escribe en el portal.
//
// Toda la lectura de las páginas se hace AQUÍ; el lector solo descarga y reenvía.
//  Ronda 1: POST { lector, ronda: 1, profesional, segundos, listas: { pendiente_cita, citado, en_curso } (html) }
//           → { ok, lectura, nuevos, desaparecidos, pedir: [nº…] }  (fichas que quiere: las de las listas y las
//             de los que dejaron de salir hace < 3 días, para saber cómo acabaron; máx. 40, las más antiguas antes)
//  Ronda 2: POST { lector, ronda: 2, lectura, segundos, fichas: { <nº>: html | { error } } }  (en tandas)
//  Error:   POST { lector, profesional?, segundos, error }  (no pudo entrar o descargar)
// Autenticación: cabecera x-onred-lector (su huella SHA-256 está en privado.ajustes 'onred_lector_hash')
// o x-kubel-secreto (pruebas desde la BD).
import postgres from 'npm:postgres@3.4.4';
import { leerFicha, leerLista, type Fila } from '../_onred/leer.ts';

const LISTAS = ['pendiente_cita', 'citado', 'en_curso'] as const;
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

async function huella(t: string) {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function autorizado(req: Request) {
  const filas = await sql`select clave, valor from privado.ajustes where clave in ('onred_lector_hash', 'notif_secreto')`;
  const a = Object.fromEntries(filas.map((f) => [f.clave, f.valor]));
  const lector = req.headers.get('x-onred-lector');
  if (lector && a.onred_lector_hash && (await huella(lector.trim())) === a.onred_lector_hash) return true;
  const s = req.headers.get('x-kubel-secreto');
  return !!(s && a.notif_secreto && s === a.notif_secreto);
}

async function avisar(nuevo: Record<string, unknown>) {
  try {
    const [a] = await sql`select valor from privado.ajustes where clave = 'notif_secreto'`;
    await fetch(Deno.env.get('SUPABASE_URL') + '/functions/v1/notificar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kubel-secreto': a.valor },
      body: JSON.stringify({ tabla: 'onred', evento: 'resumen', nuevo }), signal: AbortSignal.timeout(20000),
    });
  } catch (err) { console.error('avisar', (err as Error).message); }
}

type Cuerpo = {
  lector?: string; ronda?: number; lectura?: number; profesional?: string; segundos?: number; error?: string;
  listas?: Record<string, string>; fichas?: Record<string, string | { error: string }>;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Solo POST' }, 405);
  if (!(await autorizado(req))) return new Response('no', { status: 401 });
  let c: Cuerpo;
  try { c = await req.json(); } catch { return json({ ok: false, error: 'JSON no válido' }, 400); }
  const ronda = c.ronda === 2 ? 2 : 1;
  const base = { lector: c.lector ?? null, profesional: c.profesional ?? null, segundos: c.segundos ?? null };

  // El lector no pudo entrar o descargar: solo se apunta
  if (c.error) {
    const [ant] = await sql`select ok from public.onred_lecturas order by id desc limit 1`;
    await sql`insert into public.onred_lecturas (ok, error, profesional, lector, segundos)
              values (false, ${c.error.slice(0, 1000)}, ${base.profesional}, ${base.lector}, ${base.segundos})`;
    if (!ant || ant.ok) await avisar({ error: c.error.slice(0, 200) }); // solo la primera vez que falla
    return json({ ok: true, apuntado: 'error' });
  }

  // 1) Listas (solo en la ronda 1, y deben venir las tres para poder decir qué ha desaparecido)
  const filas = new Map<string, Fila>();
  const cuenta: Record<string, number> = {};
  let listasCompletas = false;
  if (ronda === 1) {
    try {
      for (const l of LISTAS) {
        const html = c.listas?.[l];
        if (typeof html !== 'string') throw new Error(`Falta la lista ${l}`);
        const fs = leerLista(html, l);
        cuenta[l] = fs.length;
        for (const f of fs) if (!filas.has(f.numero)) filas.set(f.numero, f);
      }
      listasCompletas = true;
    } catch (err) {
      await sql`insert into public.onred_lecturas (ok, error, profesional, lector, listas, segundos)
                values (false, ${(err as Error).message}, ${base.profesional}, ${base.lector}, ${sql.json(cuenta)}, ${base.segundos})`;
      return json({ ok: false, error: (err as Error).message });
    }
  }

  // 2) Fichas
  const fichas = new Map<string, { ficha?: unknown; error?: string }>();
  for (const [numero, v] of Object.entries(c.fichas ?? {})) {
    if (!/^\d{6,8}$/.test(numero)) continue;
    if (typeof v !== 'string') { fichas.set(numero, { error: String(v?.error ?? 'sin página').slice(0, 500) }); continue; }
    try { fichas.set(numero, { ficha: leerFicha(v) }); }
    catch (err) { fichas.set(numero, { error: (err as Error).message }); }
  }

  // 3) Guardar
  const r = await sql.begin(async (tx) => {
    const antes = new Set((await tx`select numero from public.onred_servicios where lista is not null`).map((x) => x.numero as string));
    const existentes = new Set((await tx`select numero from public.onred_servicios`).map((x) => x.numero as string));
    let nuevos = 0;
    for (const f of filas.values()) {
      if (!existentes.has(f.numero)) nuevos++;
      await tx`insert into public.onred_servicios (numero, lista, columnas, visto_en, desaparecido_en)
               values (${f.numero}, ${f.lista}, ${tx.json(f.columnas)}, now(), null)
               on conflict (numero) do update set lista = excluded.lista, columnas = excluded.columnas,
                 visto_en = now(), desaparecido_en = null`;
    }
    let desaparecidos = 0;
    const tocados: string[] = [...filas.keys(), ...fichas.keys()];
    if (listasCompletas) {
      const fuera = [...antes].filter((n) => !filas.has(n));
      if (fuera.length) {
        await tx`update public.onred_servicios set lista = null, desaparecido_en = now() where numero in ${tx(fuera)}`;
        desaparecidos = fuera.length;
        tocados.push(...fuera);
      }
    }
    let nFichas = 0;
    for (const [numero, f] of fichas) {
      if (f.ficha) {
        nFichas++;
        await tx`insert into public.onred_servicios (numero, ficha, ficha_en, ficha_error)
                 values (${numero}, ${tx.json(f.ficha as Record<string, unknown>)}, now(), null)
                 on conflict (numero) do update set ficha = excluded.ficha, ficha_en = now(), ficha_error = null`;
      } else {
        await tx`update public.onred_servicios set ficha_error = ${f.error ?? null} where numero = ${numero}`;
      }
    }
    if (ronda === 2) {
      // Suma las fichas a la lectura de la ronda 1
      if (c.lectura) await tx`update public.onred_lecturas set fichas = coalesce(fichas, 0) + ${nFichas},
                                segundos = coalesce(${base.segundos}, segundos) where id = ${c.lectura}`;
      return { fichas: nFichas, pedir: [] as string[], tocados };
    }
    // Fichas que quiere KUBEL: todas las de las listas y las de los que dejaron de salir hace < 3 días (cada 6 h)
    // y las de los servicios OnRed de KUBEL aún abiertos que no salen en las listas (alta a mano o desaparecidos),
    // cada 6 h, para saber si ONRED los ha terminado, cerrado o anulado
    const pedir = (await tx`select numero, ficha_en from public.onred_servicios
                  where lista is not null
                     or (desaparecido_en > now() - interval '3 days' and (ficha_en is null or ficha_en < now() - interval '6 hours'))
                  union
                  select p.numero_servicio, s.ficha_en from public.partes p
                  left join public.onred_servicios s on s.numero = p.numero_servicio
                  where p.compania_id = 4 and p.estado not in ('cerrado', 'anulado') and p.numero_servicio ~ '^[0-9]{6,8}$'
                    and coalesce(s.lista, '') = '' and (s.ficha_en is null or s.ficha_en < now() - interval '6 hours')
                  order by 2 nulls first limit 40`).map((x) => x.numero as string);
    const [l] = await tx`insert into public.onred_lecturas (ok, profesional, lector, listas, fichas, nuevos, desaparecidos, segundos)
             values (true, ${base.profesional}, ${base.lector}, ${tx.json(cuenta)}, 0, ${nuevos}, ${desaparecidos}, ${base.segundos})
             returning id`;
    return { lectura: l.id as number, nuevos, desaparecidos, pedir, tocados };
  });

  // 4) Volcar en Servicios y avisar a la oficina
  const { tocados, ...resto } = r;
  let volcado: { nuevos: unknown[]; cerrados: unknown[]; unidos: unknown[] } | null = null;
  if (tocados.length) {
    const [v] = await sql`select privado.onred_volcar(${sql.array(tocados)}::text[]) as v`;
    volcado = v.v;
    if (volcado && (volcado.nuevos.length || volcado.cerrados.length)) await avisar({ nuevos: volcado.nuevos, cerrados: volcado.cerrados });
  }
  return json({ ok: true, ...resto, volcado });
});
