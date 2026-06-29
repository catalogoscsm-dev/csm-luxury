'use strict';
/**
 * gerar-modelos-3d.js
 * Gera modelos 3D (.glb) para todos os produtos da CSM via TripoSR (Hugging Face — gratuito)
 *
 * Pipeline por produto:
 *   1. Baixa a imagem do produto (API WordPress)
 *   2. Faz upload para o HF Space
 *   3. /preprocess  → remove fundo branco, recorta o móvel
 *   4. /generate    → gera OBJ + GLB (pegamos o GLB)
 *   5. Baixa e salva em modelos-3d/<slug>.glb
 *   6. Salva progresso (pode ser interrompido e retomado)
 *
 * Uso:
 *   node gerar-modelos-3d.js
 *   node gerar-modelos-3d.js --limite 10     (testa com 10 produtos)
 *   node gerar-modelos-3d.js --refazer       (ignora progresso salvo)
 */

const fs   = require('fs');
const path = require('path');

// ── Configurações ─────────────────────────────────────────────────────────────
const BASE      = 'https://www.csmdecor.com.br/wsite';
const HF_SPACE  = 'https://stabilityai-triposr.hf.space';
const OUT_DIR   = path.join(__dirname, 'modelos-3d');
const PROG_FILE = path.join(__dirname, '.modelos-progress.json');
const MAP_FILE  = path.join(__dirname, 'modelos-3d-map.json');

const MC_RESOLUTION = 256;   // qualidade da malha 3D (32–320; maior = mais detalhado, mais lento)
const FOREGROUND    = 0.85;  // quanto do frame o móvel ocupa após recorte (0.5–1.0)
const DELAY_OK      = 3000;  // pausa entre produtos com sucesso (ms)
const DELAY_FAIL    = 8000;  // pausa após falha (ms)
const TIMEOUT_MS    = 360_000; // 6 min de timeout por modelo

// ── CLI args ──────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const LIMITE  = (() => { const i = args.indexOf('--limite'); return i >= 0 ? parseInt(args[i + 1]) : Infinity; })();
const REFAZER = args.includes('--refazer');

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bar   = '═'.repeat(46);

function loadProgress() {
  if (REFAZER) return {};
  try { return JSON.parse(fs.readFileSync(PROG_FILE, 'utf8')); }
  catch { return {}; }
}
function saveProgress(p) {
  fs.writeFileSync(PROG_FILE, JSON.stringify(p, null, 2));
}
function loadMapping() {
  try { return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); }
  catch { return {}; }
}
function saveMapping(m) {
  fs.writeFileSync(MAP_FILE, JSON.stringify(m, null, 2));
}

function fmt(n) { return n.toString().padStart(3); }
function kb(bytes) { return `${(bytes / 1024).toFixed(0)} KB`; }

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function httpGet(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'CSM-3D-Generator/1.0' },
      });
      return res;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

async function httpPost(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': 'CSM-3D-Generator/1.0', ...headers },
    body,
  });
}

// ── WP API — busca todos os produtos ─────────────────────────────────────────
async function fetchAllProducts() {
  const all = [];
  let page = 1;
  while (true) {
    const url = `${BASE}/?rest_route=%2Fwp%2Fv2%2Fproduct&per_page=100&page=${page}&_embed=true`;
    const res = await httpGet(url);
    if (!res || !res.ok) break;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    all.push(...data);
    const totalPages = parseInt(res.headers.get('X-WP-TotalPages') || '1');
    if (page >= totalPages) break;
    page++;
    await sleep(400);
  }
  return all;
}

// ── HF Space — upload da imagem ───────────────────────────────────────────────
async function uploadImage(imgUrl) {
  const imgRes = await httpGet(imgUrl);
  if (!imgRes || !imgRes.ok) throw new Error(`Não foi possível baixar imagem (${imgRes?.status})`);
  const buffer = await imgRes.arrayBuffer();

  const form = new FormData();
  form.append('files', new Blob([buffer], { type: 'image/jpeg' }), 'product.jpg');

  const upRes = await httpPost(`${HF_SPACE}/upload`, form);
  if (!upRes.ok) {
    const t = await upRes.text();
    throw new Error(`Upload falhou (${upRes.status}): ${t.slice(0, 120)}`);
  }

  const paths = await upRes.json();
  if (!Array.isArray(paths) || !paths[0]) throw new Error('Upload não retornou path');
  return paths[0]; // "/tmp/gradio/xxx/product.jpg"
}

function makeFileData(serverPath) {
  return {
    path: serverPath,
    url: `${HF_SPACE}/file=${serverPath}`,
    orig_name: 'product.jpg',
    mime_type: 'image/jpeg',
    size: null,
    is_stream: false,
    meta: { _type: 'gradio.FileData' },
  };
}

// ── HF Space — chama endpoint e aguarda SSE ───────────────────────────────────
async function callEndpoint(endpoint, data) {
  const res = await httpPost(
    `${HF_SPACE}/call/${endpoint}`,
    JSON.stringify({ data }),
    { 'Content-Type': 'application/json' }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`/${endpoint} falhou (${res.status}): ${t.slice(0, 120)}`);
  }
  const { event_id } = await res.json();
  if (!event_id) throw new Error(`/${endpoint} não retornou event_id`);
  return event_id;
}

async function waitSSE(endpoint, eventId) {
  const url = `${HF_SPACE}/call/${endpoint}/${eventId}`;
  const res = await httpGet(url);
  if (!res || !res.ok) throw new Error(`SSE falhou (${res?.status})`);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout de ${TIMEOUT_MS / 60000} min`)),
      TIMEOUT_MS
    );

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';

    (async function read() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            clearTimeout(timer);
            reject(new Error('Stream encerrado sem resultado'));
            return;
          }
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (line === 'event: complete') {
              const next = (lines[i + 1] || '').trim();
              if (next.startsWith('data: ')) {
                clearTimeout(timer);
                try {
                  resolve(JSON.parse(next.slice(6)));
                } catch (e) {
                  reject(new Error(`Parse do resultado falhou: ${e.message}`));
                }
                return;
              }
            }

            if (line === 'event: error') {
              clearTimeout(timer);
              const next = (lines[i + 1] || '').replace('data: ', '');
              reject(new Error(`Erro do Space: ${next.slice(0, 120)}`));
              return;
            }
          }
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    })();
  });
}

// ── Pipeline: imagem → .glb ───────────────────────────────────────────────────
async function generateGlb(imgUrl) {
  // 1. Upload
  const serverPath = await uploadImage(imgUrl);
  const fileData   = makeFileData(serverPath);

  // 2. Preprocess (remove fundo, recorta o móvel)
  const ppEventId = await callEndpoint('preprocess', [fileData, true, FOREGROUND]);
  const ppResult  = await waitSSE('preprocess', ppEventId);
  const processed = Array.isArray(ppResult) ? ppResult[0] : ppResult;
  if (!processed) throw new Error('Preprocess não retornou imagem processada');

  // 3. Generate (OBJ + GLB)
  const genEventId = await callEndpoint('generate', [processed, MC_RESOLUTION]);
  const genResult  = await waitSSE('generate', genEventId);
  // genResult[0] = OBJ, genResult[1] = GLB
  const glbInfo = Array.isArray(genResult) ? genResult[1] : genResult;
  if (!glbInfo) throw new Error('Generate não retornou arquivo GLB');

  return glbInfo;
}

// ── Download do .glb ──────────────────────────────────────────────────────────
async function downloadGlb(fileInfo, outPath) {
  const url = fileInfo.url || `${HF_SPACE}/file=${fileInfo.path}`;
  const res = await httpGet(url);
  if (!res || !res.ok) throw new Error(`Download .glb falhou (${res?.status})`);
  const buf = await res.arrayBuffer();
  fs.writeFileSync(outPath, Buffer.from(buf));
  return buf.byteLength;
}

// ── Verifica se o Space está online ──────────────────────────────────────────
async function checkSpace() {
  process.stdout.write('🔌 Verificando Hugging Face Space... ');
  try {
    const res = await fetch(`${HF_SPACE}/info`, { signal: AbortSignal.timeout(15000) });
    if (res.ok) { console.log('online ✓\n'); return true; }
  } catch {}
  console.log('\n⏳ Space pode estar hibernando, aguardando 20 segundos...');
  await sleep(20000);
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${bar}`);
  console.log('  CSM Decor — Gerador de Modelos 3D');
  console.log(`  Powered by TripoSR · Hugging Face (grátis)`);
  console.log(`${bar}\n`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  await checkSpace();

  console.log('📦 Buscando produtos na API WordPress...');
  const products = await fetchAllProducts();
  if (!products.length) {
    console.log('❌ Nenhum produto encontrado. Verifique a conexão.');
    return;
  }

  const limited = LIMITE < Infinity ? products.slice(0, LIMITE) : products;
  console.log(`✅ ${products.length} produtos encontrados${LIMITE < Infinity ? ` (testando ${LIMITE})` : ''}\n`);

  const progress = loadProgress();
  const mapping  = loadMapping();

  let done = 0, skipped = 0, failed = 0;

  for (let i = 0; i < limited.length; i++) {
    const p      = limited[i];
    const id     = String(p.id);
    const name   = (p.title?.rendered || `produto-${id}`).replace(/<[^>]+>/g, '').trim();
    const slug   = (p.slug || id).replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 60);
    const imgUrl = p._embedded?.['wp:featuredmedia']?.[0]?.source_url
                || p._embedded?.['wp:featuredmedia']?.[0]?.media_details?.sizes?.woocommerce_thumbnail?.source_url;

    const glbName = `${slug}.glb`;
    const glbPath = path.join(OUT_DIR, glbName);
    const relPath = `modelos-3d/${glbName}`;
    const prefix  = `[${fmt(i + 1)}/${fmt(limited.length)}]`;

    if (!imgUrl) {
      console.log(`${prefix} ⚠️  ${name} — sem imagem, pulando`);
      skipped++;
      continue;
    }

    // Já gerado anteriormente
    if (!REFAZER && progress[id] === 'done' && fs.existsSync(glbPath)) {
      console.log(`${prefix} ✓  ${name}`);
      mapping[id] = { slug, path: relPath, name };
      done++;
      continue;
    }

    console.log(`\n${prefix} 🔄  ${name}`);

    try {
      process.stdout.write('   ▸ Upload da imagem... ');
      // (feito internamente em generateGlb, mas indicamos aqui para o usuário)

      process.stdout.write('\r   ▸ Removendo fundo e gerando 3D (aguarde 1–3 min)... ');
      const glbInfo = await generateGlb(imgUrl);
      process.stdout.write('\r   ▸ Gerando 3D... ✓                                      \n');

      process.stdout.write('   ▸ Salvando .glb... ');
      const bytes = await downloadGlb(glbInfo, glbPath);
      console.log(`✓  (${kb(bytes)})`);

      mapping[id]  = { slug, path: relPath, name };
      progress[id] = 'done';
      saveProgress(progress);
      saveMapping(mapping);
      done++;

      await sleep(DELAY_OK);

    } catch (err) {
      console.log(`\n   ❌ ${err.message}`);
      progress[id] = 'failed';
      saveProgress(progress);
      failed++;
      await sleep(DELAY_FAIL);
    }
  }

  // Relatório final
  console.log(`\n${bar}`);
  console.log(`  ✅ Gerados com sucesso : ${done}`);
  console.log(`  ❌ Falharam            : ${failed}`);
  console.log(`  ⚠️  Sem imagem          : ${skipped}`);
  console.log(`${bar}`);
  console.log(`\n📁 Modelos em          : modelos-3d/  (${done} arquivos .glb)`);
  console.log(`📋 Mapeamento em        : modelos-3d-map.json`);

  if (failed > 0) {
    console.log(`\n💡 Para refazer apenas os que falharam, rode novamente sem --refazer.`);
    console.log(`   O script pula automaticamente os que já foram gerados com sucesso.`);
  }

  if (done > 0) {
    console.log(`\n🚀 Próximo passo: rode  node aplicar-modelos-3d.js`);
    console.log(`   para atualizar produtos.html com os modelos 3D corretos.\n`);
  }
}

main().catch(err => {
  console.error(`\n💥 Erro fatal: ${err.message}`);
  process.exit(1);
});
