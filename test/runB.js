// 专门运行场景B（纯思考模型）- 已验证只需1轮
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const bp = fs.readFileSync(path.join(__dirname, '..', 'blueprint.md'), 'utf-8');

const prompt = `以下是一个 MCP Server 项目的工程蓝图文档。请从架构改进、功能增强、可靠性提升、开发体验、性能优化五个维度提出具体的改进方案。\n\n---\n\n${bp}`;

async function main() {
  console.log('📋 场景B：纯思考模型（无工具）');
  const start = Date.now();
  const data = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'system', content: '你是一个资深软件架构师，请仅依靠自身推理能力进行分析。' }, { role: 'user', content: prompt }],
      thinking: {type: 'enabled'},
      reasoning_effort: 'high',
      stream: false
    })
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  
  const elapsed = ((Date.now()-start)/1000).toFixed(1);
  const msg = data.choices?.[0]?.message;
  console.log(`  完成: ${elapsed}s`);
  console.log(`  推理: ${(msg?.reasoning_content||'').length}字`);
  console.log(`  输出: ${(msg?.content||'').length}字`);
  console.log(`  Token: ${JSON.stringify(data.usage)}`);
  
  // 保存
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const md = `# 场景B：纯思考模型（无工具）\n\n**耗时**: ${elapsed}s\n**Token**: prompt=${data.usage?.prompt_tokens}, completion=${data.usage?.completion_tokens}, total=${data.usage?.total_tokens}\n\n## 思考过程\n\`\`\`\n${msg?.reasoning_content||'(无)'}\n\`\`\`\n\n## 最终输出\n\n${msg?.content||''}`;
  fs.writeFileSync(path.join(__dirname, 'results', `without-tool-${ts}.md`), md, 'utf-8');
  fs.writeFileSync(path.join(__dirname, 'results', `without-tool-${ts}.json`), JSON.stringify({mode:'without-tool', timestamp: new Date().toISOString(), usage: data.usage, content: msg?.content, reasoning: msg?.reasoning_content, elapsedSec: parseFloat(elapsed)}, null, 2), 'utf-8');
  console.log(`  已保存`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
