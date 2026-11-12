// KUBEL — Análisis de las páginas del portal ONRED (CronosP). Compartido por onred-recibir
// (y, más adelante, onred-sync). Solo lee HTML: no conecta con el portal.
import { DOMParser, Element } from 'https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts';

export const limpio = (t?: string | null) => (t ?? '').replace(/ /g, ' ').replace(/[ \t\r]+/g, ' ').replace(/ *\n */g, '\n').trim();
export const parse = (html: string) => {
  const d = new DOMParser().parseFromString(html, 'text/html');
  if (!d) throw new Error('No se pudo leer la página');
  return d;
};
export const pideLogin = (html: string) => /Login1\$UserName/.test(html);

export type Fila = { numero: string; lista: string; columnas: Record<string, string> };

export function leerLista(html: string, lista: string): Fila[] {
  if (pideLogin(html)) throw new Error(`Sesión caducada en la lista ${lista}`);
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

// Tabla de un GridView como lista de objetos (cabecera = primera fila)
function tablaDe(t: Element | null) {
  if (!t) return [] as Record<string, string>[];
  const trs = [...t.querySelectorAll('tr')] as Element[];
  const cab = [...(trs[0]?.querySelectorAll('th,td') ?? [])].map((c) => limpio((c as Element).textContent));
  return trs.slice(1).map((tr) => {
    const o: Record<string, string> = {};
    [...tr.querySelectorAll('td')].forEach((c, i) => { if (cab[i]) o[cab[i]] = limpio((c as Element).textContent); });
    return o;
  }).filter((o) => Object.values(o).some(Boolean));
}

// «1.234,56» → 1234.56
export const numero = (t?: string | null) => {
  const s = (t ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  return s === '' || isNaN(Number(s)) ? null : Number(s);
};

// Ventana «Valoración» (VerServicio.aspx?id=3_<nº>_<prof> tras pulsar Valoración). Solo lectura.
// servicios = una fila por servicio del siniestro (Pend / Acep / Rech / Total, sin IVA); partidas = líneas valoradas.
export function leerValoracion(html: string) {
  if (pideLogin(html)) throw new Error('Sesión caducada en la Valoración');
  const d = parse(html);
  const porFin = (sufijo: string) =>
    ([...d.querySelectorAll('[id]')] as Element[]).find((e) => e.getAttribute('id')!.endsWith('UCValoraciones_' + sufijo)) ?? null;
  const gv = porFin('GVServicios');
  if (!gv) throw new Error('La página no trae la Valoración');
  const servicios = tablaDe(gv).map((o) => ({
    numero: o['Servicios'] ?? '', profesion: o['Profesión'] ?? '', profesional: o['Profesional'] ?? '',
    estado: o['Estado Serv.'] ?? '', pend: numero(o['Pend']), acep: numero(o['Acep']), rech: numero(o['Rech']), total: numero(o['Total']),
  })).filter((s) => /^\d{6,8}$/.test(s.numero));
  const val = (s: string) => numero(porFin(s)?.getAttribute('value'));
  const sin = /Valoraciones del Siniestro\s*(\d+)/.exec(limpio(d.body?.textContent ?? ''));
  return {
    siniestro: sin?.[1] ?? null,
    servicios,
    partidas: tablaDe(porFin('GVPartidasProf')),
    totales: { total: val('TxtTotVal'), franquicia: val('TxtimpFranquicia'), saldo_franquicia: val('TxtImpSaldoFranquicia'),
               aceptado: val('TxtImpAcep'), pendiente: val('TxtImpPend') },
  };
}

export function leerFicha(html: string) {
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
