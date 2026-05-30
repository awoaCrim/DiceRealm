import { useState, type ChangeEvent } from 'react';
import { importSillyTavernPresetPackage, importSillyTavernScriptCard, importSillyTavernWorldBook } from '../api';
import type { JsonObject, JsonValue, PromptPresetPackage, ResourceWorldBook, ScriptCard } from '../types';
import { ResourceReviewPanel } from './ResourceReviewPanel';

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonFile(file: File): Promise<JsonValue | undefined> {
  const parsed = JSON.parse(await file.text()) as unknown;
  return parsed as JsonValue;
}

async function readJsonObjectFile(file: File): Promise<JsonObject | undefined> {
  const parsed = await readJsonFile(file);
  return parsed && isJsonObject(parsed) ? parsed : undefined;
}

type ImportResult = {
  title: string;
  name: string;
  warnings: string[];
};

export function ResourceImportPanel({
  scriptCards,
  resourceWorldBooks,
  presetPackages,
  onImported,
  setError
}: {
  scriptCards: ScriptCard[];
  resourceWorldBooks: ResourceWorldBook[];
  presetPackages: PromptPresetPackage[];
  onImported: () => Promise<void>;
  setError: (message: string) => void;
}) {
  const [result, setResult] = useState<ImportResult | null>(null);
  const [worldBookFallbackName, setWorldBookFallbackName] = useState('');
  const [openAiSettingsFile, setOpenAiSettingsFile] = useState<File | null>(null);
  const [contextTemplateFile, setContextTemplateFile] = useState<File | null>(null);
  const [instructTemplateFile, setInstructTemplateFile] = useState<File | null>(null);
  const [syspromptFile, setSyspromptFile] = useState<File | null>(null);
  const [reasoningTemplateFile, setReasoningTemplateFile] = useState<File | null>(null);

  async function importScriptCard(file: File | undefined) {
    if (!file) return;
    setError('');
    setResult(null);
    try {
      const characterCard = await readJsonObjectFile(file);
      if (!characterCard) throw new Error('角色卡 JSON 必须是对象。');
      const response = await importSillyTavernScriptCard(characterCard);
      setResult({ title: '导入 ST 角色卡为剧本卡', name: response.scriptCard.name, warnings: response.warnings });
      await onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function importWorldBook(file: File | undefined) {
    if (!file) return;
    setError('');
    setResult(null);
    try {
      const worldBook = await readJsonObjectFile(file);
      if (!worldBook) throw new Error('世界书 JSON 必须是对象。');
      const response = await importSillyTavernWorldBook(worldBook, worldBookFallbackName.trim() || undefined);
      setResult({ title: '导入 ST 世界书', name: `${response.worldBook.name}（${response.entries.length} 条）`, warnings: response.warnings });
      await onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function importPresetPackage() {
    if (!openAiSettingsFile) {
      setError('请先选择 openAI 设置 JSON。');
      return;
    }
    setError('');
    setResult(null);
    try {
      const openAiSettings = await readJsonObjectFile(openAiSettingsFile);
      if (!openAiSettings) throw new Error('openAI 设置 JSON 必须是对象。');
      const contextTemplate = contextTemplateFile ? await readJsonFile(contextTemplateFile) : undefined;
      const instructTemplate = instructTemplateFile ? await readJsonFile(instructTemplateFile) : undefined;
      const sysprompt = syspromptFile ? await readJsonFile(syspromptFile) : undefined;
      const reasoningTemplate = reasoningTemplateFile ? await readJsonFile(reasoningTemplateFile) : undefined;
      const response = await importSillyTavernPresetPackage({ openAiSettings, contextTemplate, instructTemplate, sysprompt, reasoningTemplate });
      setResult({ title: '导入 ST 预设包', name: response.presetPackage.name, warnings: response.warnings });
      await onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleScriptCardFileChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    try {
      await importScriptCard(file);
    } finally {
      input.value = '';
    }
  }

  async function handleWorldBookFileChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    try {
      await importWorldBook(file);
    } finally {
      input.value = '';
    }
  }

  return (
    <section className="card">
      <h2>全局资源库 / 导入</h2>
      <p className="muted">导入只进入全局资源库，不自动写入房间日志或开场消息。</p>

      <div className="subcard">
        <h3>导入 ST 角色卡为剧本卡</h3>
        <input type="file" accept="application/json,.json" onChange={(event) => void handleScriptCardFileChange(event)} />
      </div>

      <div className="subcard">
        <h3>导入 ST 世界书</h3>
        <label>备用名称<input value={worldBookFallbackName} onChange={(event) => setWorldBookFallbackName(event.target.value)} /></label>
        <input type="file" accept="application/json,.json" onChange={(event) => void handleWorldBookFileChange(event)} />
      </div>

      <ResourceReviewPanel setError={setError} />

      <div className="subcard">
        <h3>导入 ST 预设包</h3>
        <label>openAI 设置 JSON<input type="file" accept="application/json,.json" onChange={(event) => setOpenAiSettingsFile(event.target.files?.[0] ?? null)} /></label>
        <label>context 模板 JSON（可选）<input type="file" accept="application/json,.json" onChange={(event) => setContextTemplateFile(event.target.files?.[0] ?? null)} /></label>
        <label>instruct 模板 JSON（可选）<input type="file" accept="application/json,.json" onChange={(event) => setInstructTemplateFile(event.target.files?.[0] ?? null)} /></label>
        <label>sysprompt JSON（可选）<input type="file" accept="application/json,.json" onChange={(event) => setSyspromptFile(event.target.files?.[0] ?? null)} /></label>
        <label>reasoning 模板 JSON（可选）<input type="file" accept="application/json,.json" onChange={(event) => setReasoningTemplateFile(event.target.files?.[0] ?? null)} /></label>
        <div className="button-row">
          <button onClick={() => void importPresetPackage()}>导入预设包文件</button>
        </div>
      </div>

      {result ? (
        <div className="subcard">
          <h3>最近导入结果</h3>
          <p>{result.title}：{result.name}</p>
          {result.warnings.length ? <ul>{result.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul> : <p className="muted">无 warnings。</p>}
        </div>
      ) : null}

      <div className="subcard">
        <h3>已导入资源列表/数量</h3>
        <p>剧本卡：{scriptCards.length}</p>
        {scriptCards.map((card) => <p key={card.id}>{card.name}</p>)}
        <p>世界书：{resourceWorldBooks.length}</p>
        {resourceWorldBooks.map((book) => <p key={book.id}>{book.name}</p>)}
        <p>预设包：{presetPackages.length}</p>
        {presetPackages.map((preset) => <p key={preset.id}>{preset.name}</p>)}
      </div>
    </section>
  );
}
