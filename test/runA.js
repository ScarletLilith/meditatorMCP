// 场景A：思考模型 + MCP 工具
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const bp = fs.readFileSync(path.join(__dirname, '..', 'blueprint.md'), 'utf-8');
const prompt = `以下是一个 MCP Server 项目的工程蓝图文档。请从架构改进、功能增强、可靠性提升、开发体验、性能优化五个维度提出具体的改进方案。\n\n---\n\n${bp}`;

const TOOLS = [
  { type: 'function', function: { name: 'chat_agent', description: '调用非思考模型生成文本，用于延伸思维链。你可以传入需要独立完成的子任务。', parameters: { type: 'object', properties: { input_text: { type: 'string', description: '完整的任务描述，包含所有上下文' }, system_prompt: { type: 'string' }, temperature: { type: 'number', default: 0.7 }, top_p: { type: 'number', default: 0.9 }, max_tokens: { type: 'number', default: 4096 } }, required: ['input_text'] } } },
  { type: 'function', function: { name: 'create_branch', description: '创建思维分支节点，实现树形思维，多角度深入分析。四种类型：drill_down（深入拆解）、verify（验证结论）、explore（发散思考）、stash（记录想法）。', parameters: { type: 'object', properties: { session_id: { type: 'string', description: '会话ID' }, input_text: { type: 'string', minLength: 30, description: '完整的子任务描述' }, call_type: { type: 'string', enum: ['drill_down','verify','explore','stash'], description: '分支类型' }, parent_node_id: { type: 'string', default: 'trunk', description: '父节点ID' } }, required: ['session_id','input_text'] } } }
];

async function callAPI(body) {
  const r = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).substring(0,200)}`);
  return r.json();
}

async function main() {
  console.log('📋 场景A：思考模型 + MCP 工具');
  const conv = [{ role: 'system', content: '你是一个资深软件架构师。你可以使用 chat_agent 和 create_branch 工具进行多角度深入分析。' }, { role: 'user', content: prompt }];
  const toolHistory = [];
  const roundReasonings = [];
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let rounds = 0;
  const overallStart = Date.now();

  while (rounds < 10) {
    rounds++;
    process.stdout.write(`  [第${rounds}轮] 调用思考模型...`);
    const startTs = Date.now();
    const data = await callAPI({ model: config.model, messages: conv, thinking: {type: 'enabled'}, reasoning_effort: 'high', stream: false, tools: TOOLS });
    const elapsed = ((Date.now()-startTs)/1000).toFixed(1);
    const msg = data.choices?.[0]?.message;
    const reasoning = msg?.reasoning_content || '';
    roundReasonings.push({round: rounds, reasoning, hasToolCalls: !!(msg?.tool_calls?.length)});
    usage.prompt_tokens += data.usage?.prompt_tokens || 0;
    usage.completion_tokens += data.usage?.completion_tokens || 0;
    usage.total_tokens += data.usage?.total_tokens || 0;
    const totalElapsed = ((Date.now()-overallStart)/1000).toFixed(1);

    if (!msg?.tool_calls || msg.tool_calls.length === 0) {
      console.log(` ${elapsed}s → 完成 (累计 ${totalElapsed}s)`);
      return { finalContent: msg?.content||'', reasoning, allReasonings: roundReasonings, toolHistory, usage, rounds, elapsedSec: parseFloat(totalElapsed) };
    }

    console.log(` ${elapsed}s → ${msg.tool_calls.length}个工具调用`);
    conv.push({ role: 'assistant', content: msg.content||null, tool_calls: msg.tool_calls });

    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      const ts = Date.now();
      let result;
      try {
        if (tc.function.name === 'chat_agent') {
          const msgs = args.system_prompt ? [{role:'system',content:args.system_prompt},{role:'user',content:args.input_text}] : [{role:'user',content:args.input_text}];
          const d = await callAPI({model:'deepseek-v4-flash',messages:msgs,temperature:args.temperature||0.7,max_tokens:args.max_tokens||4096,top_p:args.top_p||0.9});
          result = JSON.stringify({success:true,content:d.choices?.[0]?.message?.content||'',usage:d.usage});
        } else if (tc.function.name === 'create_branch') {
          const temps = {drill_down:0.2,verify:0.0,explore:1.0,stash:0.6};
          const d = await callAPI({model:'deepseek-v4-flash',messages:[{role:'system',content:`分析类型: ${args.call_type||'explore'}，末尾用[最终结论]标记。`},{role:'user',content:args.input_text}],temperature:temps[args.call_type]||0.7,max_tokens:2048});
          const raw = d.choices?.[0]?.message?.content||'';
          const m = raw.match(/\[最终结论\][：:\s]*([\s\S]*?)$/);
          result = JSON.stringify({status:'success',node_id:'n_'+Math.random().toString(36).slice(2,10),conclusion:m?m[1].trim():raw.slice(-200)});
        }
      } catch(e) {
        result = JSON.stringify({error:e.message});
      }
      const toolTime = ((Date.now()-ts)/1000).toFixed(1);
      toolHistory.push({round:rounds,tool:tc.function.name,args,timeSec:parseFloat(toolTime)});
      process.stdout.write(`    ${tc.function.name} (${toolTime}s)\n`);
      if (result) {
        conv.push({role:'tool',tool_call_id:tc.id,content:result});
        // 也保存工具原始返回（包含推理）
        tc.rawResult = result;
      }
    }
  }
  return { finalContent:'[达到最大轮次]', reasoning:'', allReasonings: roundReasonings, toolHistory, usage, rounds, elapsedSec: (Date.now()-overallStart)/1000 };
}

main().then(async (a) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  // 读取场景B结果
  const bFiles = fs.readdirSync(path.join(__dirname,'results')).filter(f=>f.startsWith('without-tool-')&&f.endsWith('.json'));
  const bData = bFiles.length > 0 ? JSON.parse(fs.readFileSync(path.join(__dirname,'results',bFiles.sort().pop()),'utf-8')) : null;

  // 保存场景A
  const reasoningSections = (a.allReasonings||[]).filter(r=>r.reasoning).map(r => `## 第${r.round}轮思考过程${r.hasToolCalls ? '（→调用工具）' : '（最终输出）'}\n\n\`\`\`\n${r.reasoning}\n\`\`\``).join('\n\n');
  const aMd = `# 场景A：思考模型 + MCP 工具\n\n**耗时**: ${a.elapsedSec.toFixed(1)}s | **轮次**: ${a.rounds} | **工具调用**: ${a.toolHistory.length}\n**Token**: prompt=${a.usage.prompt_tokens}, completion=${a.usage.completion_tokens}, total=${a.usage.total_tokens}\n\n${reasoningSections}\n\n## 最终输出\n\n${a.finalContent}`;
  fs.writeFileSync(path.join(__dirname,'results',`with-tool-${ts}.md`), aMd, 'utf-8');
  fs.writeFileSync(path.join(__dirname,'results',`with-tool-${ts}.json`), JSON.stringify({mode:'with-tool',usage:a.usage,content:a.finalContent,reasoning:a.reasoning,allReasonings:a.allReasonings,elapsedSec:a.elapsedSec,rounds:a.rounds,toolHistory:a.toolHistory},null,2),'utf-8');

  // 生成报告
  const toolDist = {};
  a.toolHistory.forEach(t => { toolDist[t.tool] = (toolDist[t.tool]||0)+1; });
  
  const report = [
    `# MCP 工具 vs 纯思考模型 — 对比分析报告`,
    `**时间**: ${new Date().toISOString()} | **模型**: ${config.model}`,
    ``,
    `## 定量对比`,
    `| 指标 | 场景A (带工具) | 场景B (纯思考) | 差异 |`,
    `|------|:---:|:---:|:---:|`,
    `| 总轮次 | ${a.rounds} | ${bData ? 1 : 'N/A'} | - |`,
    `| 工具调用 | ${a.toolHistory.length} | 0 | +${a.toolHistory.length} |`,
    `| 耗时(秒) | ${a.elapsedSec.toFixed(1)} | ${bData ? bData.elapsedSec?.toFixed(1)||'N/A' : 'N/A'} | - |`,
    `| Prompt Tokens | ${a.usage.prompt_tokens} | ${bData ? bData.usage?.prompt_tokens||'N/A' : 'N/A'} | - |`,
    `| Completion Tokens | ${a.usage.completion_tokens} | ${bData ? bData.usage?.completion_tokens||'N/A' : 'N/A'} | - |`,
    `| Total Tokens | ${a.usage.total_tokens} | ${bData ? bData.usage?.total_tokens||'N/A' : 'N/A'} | - |`,
    `| 输出长度(字) | ${a.finalContent.length} | ${bData ? (bData.content||'').length : 'N/A'} | - |`,
    `| 推理过程长度(字) | ${(a.reasoning||'').length} | ${bData ? (bData.reasoning||'').length : 'N/A'} | - |`,
    ``,
    `## 工具使用情况`,
    `| 工具 | 调用次数 |`,
    `|------|:---:|`,
    ...Object.entries(toolDist).map(([t,c]) => `| ${t} | ${c} |`),
    ``,
    a.toolHistory.length > 0 ? [
      `## 工具调用详情`,
      ``,
      ...a.toolHistory.map((t,i) => `### 调用 ${i+1}: ${t.tool} (轮次 ${t.round}, ${t.timeSec}s)\n\`\`\`json\n${JSON.stringify(t.args,null,2)}\n\`\`\``)
    ].join('\n').split('\n').map(l=>l+'\n').join('') : [],
    ``,
    `## 结论`,
    `- ${a.toolHistory.length > 0 ? '✅ 模型成功使用了工具进行多角度分析' : '⚠ 模型未使用工具'}`,
    `- Token消耗：场景A ${a.usage.total_tokens} ${bData ? `vs 场景B ${bData.usage?.total_tokens||'N/A'}` : ''}`,
    `- 注意：SiliconFlow API 响应延迟波动大（20s-309s），导致测试耗时较长`,
  ].join('\n');

  fs.writeFileSync(path.join(__dirname,'results',`comparison-analysis-${ts}.md`), report, 'utf-8');
  console.log(`\n📊 报告已保存\n${report}`);
}).catch(e => { console.error('❌', e.message); });
