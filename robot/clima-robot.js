// =============================================================
//  Robot del clima (GitHub Actions, cada 15 min)
//
//  Corre el MISMO revisor que usa la app del celular (app/runner-clima.js):
//  lee la REM (Las Chacras, viento de San Luis Rural, pronostico de La Punta) y las
//  alertas del SMN, y deja el resultado en datos/clima.json.
//  El workflow sube ese archivo a la rama "datos" del repo; la pagina
//  para PC lo lee de ahi (GitHub lo permite, la REM no).
//
//  Ademas, con --publicar, manda las alertas al broker MQTT (retenidas):
//    vivero/clima/alerta  -> JSON con las alertas vigentes (lo muestra la app)
//    vivero/clima/cierre  -> hasta cuando cerrar el venteo (epoch; 0 = no). Lo lee la placa
//  Cierran el venteo los avisos del SMN de viento, tormenta, granizo, zonda o nieve,
//  y una rafaga fuerte medida por la REM (campo "cierra" del revisor), 30 min antes de empezar.
//  Necesita MQTT_USER y MQTT_PASS (secretos de GitHub); sin ellos no publica.
//
//  Uso: node robot/clima-robot.js <carpeta de datos>               (lee REM y SMN)
//       node robot/clima-robot.js <carpeta de datos> --publicar    (publica lo leido)
// =============================================================
const fs = require('fs'), path = require('path'), vm = require('vm');

const DIR = process.argv[2] || 'datos';
const ANTICIPO_S = 30 * 60;                            // cerrar 30 min antes de que empiece el aviso

// ---------- Publicar en el broker (paso aparte: si falla, clima.json ya se subio igual) ----------
async function publicar() {
  const username = process.env.MQTT_USER, password = process.env.MQTT_PASS;
  if (!username || !password) { console.log('Sin MQTT_USER / MQTT_PASS: no se publica en el broker.'); return; }
  const r = JSON.parse(fs.readFileSync(path.join(DIR, 'clima.json'), 'utf8'));
  const ahora = Math.floor(Date.now() / 1000);
  const vig = (r.alertas || []).filter(a => a.hasta > ahora);
  const cierre = Math.max(0, ...vig.filter(a => a.cierra && a.desde - ANTICIPO_S <= ahora).map(a => a.hasta));
  const alerta = { actualizado: ahora, fuente: 'SMN (CC BY 4.0) y REM',
    alertas: vig.map(a => ({ id: a.id, evento: a.evento, nivel: a.nivel, desde: a.desde, hasta: a.hasta, texto: a.texto, cierra: a.cierra, fuente: a.fuente })) };
  const mqtt = require('mqtt');
  const host = process.env.MQTT_HOST || 'p64138d1.ala.us-east-1.emqxsl.com';
  const c = await mqtt.connectAsync('mqtts://' + host + ':8883', {
    username, password, clientId: 'vivero-clima-' + Math.random().toString(16).slice(2, 8), connectTimeout: 15000, reconnectPeriod: 0 });
  await c.publishAsync('vivero/clima/alerta', JSON.stringify(alerta), { qos: 1, retain: true });
  await c.publishAsync('vivero/clima/cierre', String(cierre), { qos: 1, retain: true });
  await c.endAsync();
  console.log('Broker: ' + vig.length + ' alerta(s) vigente(s); cierre de venteo ' + (cierre ? 'hasta ' + new Date(cierre * 1000).toISOString() : 'no'));
}
if (process.argv.includes('--publicar')) {
  publicar().catch(e => { console.error('No se pudo publicar en el broker:', e.message || e); process.exit(1); });
  return;
}
const KV_ARCHIVO = path.join(DIR, 'kv.json');          // memoria del revisor (cache del SMN)
fs.mkdirSync(DIR, { recursive: true });
let kv = {};
try { kv = JSON.parse(fs.readFileSync(KV_ARCHIVO, 'utf8')); } catch (e) {}

const handlers = {};
const ctx = {
  console, Date, Math, JSON, Promise, String, Number, Object, Array, parseFloat, parseInt, RegExp, Error, setTimeout,
  fetch: (url, op) => fetch(url, op),                    // fetch de Node 20
  CapacitorKV: { get: (k) => ({ value: kv[k] }), set: (k, v) => { kv[k] = v; }, remove: (k) => { delete kv[k]; } },
  CapacitorNotifications: { schedule: () => {} },        // el robot no notifica (eso lo hace el celular)
  addEventListener: (ev, fn) => { handlers[ev] = fn; },
};
vm.createContext(ctx);
// En el repo privado esta en app/runner-clima.js; en el repo publico de la pagina, en runners/clima.js
const REVISOR = [path.join(__dirname, '..', 'app', 'runner-clima.js'), path.join(__dirname, '..', 'runners', 'clima.js')].find(f => fs.existsSync(f));
vm.runInContext(fs.readFileSync(REVISOR, 'utf8'), ctx);
const disparar = (ev, args) => new Promise((res, rej) => handlers[ev](res, rej, args));

(async () => {
  const lat = parseFloat(process.env.VIVERO_LAT), lon = parseFloat(process.env.VIVERO_LON);
  const cfg = { avisos: false };
  if (!isNaN(lat) && !isNaN(lon)) Object.assign(cfg, { lat, lon });
  const final = await disparar('guardarConfig', cfg);
  console.log('Config:', `estacion ${final.estacion}, viento ${final.estacionViento}, pronostico ${final.pronostico}, punto ${final.lat},${final.lon}`);
  const r = await disparar('revisarClima', {});
  r.fuente = 'robot';
  fs.writeFileSync(path.join(DIR, 'clima.json'), JSON.stringify(r));
  fs.writeFileSync(KV_ARCHIVO, JSON.stringify(kv));
  const e = r.estacion;
  console.log('Estacion:', e ? `${e.nombre} ${e.temp} °C ${e.hum} % (${e.hora})` : 'sin datos');
  console.log('Pronostico:', r.pronostico ? r.pronostico.dias.map(d => `${d.dia} ${d.min}/${d.max}`).join(' | ') : 'sin datos');
  console.log('Alertas:', r.alertas.length ? r.alertas.map(a => `${a.nivel} ${a.evento}`).join(' | ') : 'ninguna');
  if (r.errores.length) console.log('Errores:', r.errores.join(' | '));
  // Si no se pudo leer nada, que el workflow falle (se ve en rojo en Actions)
  if (!e && !r.pronostico) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
