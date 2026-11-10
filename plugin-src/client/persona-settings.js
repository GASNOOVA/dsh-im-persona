// 机器人设置页里的「人设」编辑器（v2：人设库 / 自定义）。
//
// 数据结构：每机器人 v2 配置 `{ enabled, source, personaId, name, tone, instructions }`；
// 人设库（builtin 大肥鱼 + 用户导入 + 可选 config personaFile）通过管理 RPC 管理。
//
// 约定：
// - 与 context-enhancement.js 相同，只用 `h`/`localizeText` 组织的字面量，不硬编码
//   i18n 命名空间或品牌串；
// - 复用 `dim-context*` 结构样式，额外挂 `dim-persona*` 类名；
// - 用户填写/导入的正文只出现在输入框/只读 textarea 的 value 里，绝不作为 React
//   文本节点渲染，避免被设置页的动态翻译规则改写；
// - 本地文件读取只在浏览器端（FileReader），文件路径不离开本机。

import * as React from 'react';
import { createPortal } from 'react-dom';

import {
  DEFAULT_PERSONA_CONFIG,
  PERSONA_INSTRUCTIONS_EXAMPLE,
  PERSONA_INSTRUCTIONS_MAX_LENGTH,
  PERSONA_LIBRARY_ENDPOINTS,
  PERSONA_LIBRARY_NAME_MAX_LENGTH,
  PERSONA_LIBRARY_TEXT_MAX_LENGTH,
  PERSONA_NAME_MAX_LENGTH,
  PERSONA_TONE_EXAMPLE,
  PERSONA_TONE_MAX_LENGTH,
  normalizePersonaConfig,
  personaBlock,
  personaConfigIsActive,
  personaLabel,
  validatePersonaConfig,
} from '../../src/channels/shared/persona.mjs';
import { h, localizeText } from './i18n.js';

const PREVIEW_LABEL = '注入预览';
const FILE_EXTENSIONS = ['.md', '.markdown', '.txt'];
const FILE_ACCEPT = '.md,.markdown,.txt,text/markdown,text/plain';

function PersonaIcon({ kind = 'user' }) {
  const path = kind === 'close' ? 'M6 6l12 12M6 18 18 6'
    : kind === 'chevron' ? 'm9 5 7 7-7 7'
      : 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 21a7.5 7.5 0 0 1 15 0';
  return h('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true', focusable: 'false',
  }, h('path', { d: path }));
}

/** 通过传入的人设管理 RPC 调用并拆包；非 ok 抛错（message 可直接展示）。 */
async function callPersonaRpc(rpcCall, endpoint, payload = {}) {
  if (typeof rpcCall !== 'function') {
    throw new Error('人设管理接口不可用，请重新打开设置页。');
  }
  const result = await rpcCall(endpoint, payload);
  if (!result || typeof result.ok !== 'boolean') {
    throw new Error('人设服务返回了无法识别的响应。');
  }
  if (result.ok !== true) {
    throw Object.assign(
      new Error(result.error?.message ?? '人设操作失败，请稍后重试。'),
      { code: result.error?.code },
    );
  }
  return result.value;
}

function Field({ id, label, hint, actions = null, control }) {
  return h('div', { className: 'dim-personaField dim-contextScopeBlock' },
    h('div', { className: 'dim-contextEditorHeader' },
      h('span', { className: 'dim-contextEditorTitle' }, h('label', { htmlFor: id }, label)),
      actions),
    h('div', { className: 'dim-personaControl' }, control),
    hint ? h('p', { className: 'dim-personaHint' }, hint) : null);
}

function PersonaHeader({ titleId, descriptionId, busy, onCancel }) {
  return h('header', { className: 'dim-contextHeader dim-personaHeader' },
    h('div', { className: 'dim-contextHeaderTitle' },
      h('h3', { id: titleId }, '人设'),
      h('span', { className: 'dim-contextHelp dim-contextHeaderHelp' },
        h('button', {
          type: 'button', className: 'dim-contextHelpButton', disabled: busy,
          'aria-label': '查看人设说明', 'aria-describedby': descriptionId,
        }, h('span', { 'aria-hidden': 'true' }, '?')),
        h('span', {
          id: descriptionId,
          className: 'dim-contextTooltip dim-contextHeaderTooltip',
          role: 'tooltip',
        },
        h('strong', null, '使用说明'),
        h('span', null, '人设可以来自内置的大肥鱼、你导入的人设库条目，或这台机器人自己的自定义角色。启用后，每条进入 Harness 的用户消息都会在正文前带上 <dsh_im_persona> 人设块；Harness 会把它拆成独立的人设上下文，用户消息本身保持原样。'),
        h('strong', null, '生效范围'),
        h('span', null, '人设按机器人保存，对该机器人的所有会话生效；命令、审批回答和提问回答不会注入。'),
        h('strong', null, '不会改变什么'),
        h('span', null, '不改动系统提示词、Agent Preset、模型、工具、权限、工作区与会话绑定。'),
        h('strong', null, '生效时机'),
        h('span', null, '保存后从下一条进入 Harness 的消息开始生效；不需要重新连接机器人或发送 /new。')))),
    h('button', {
      type: 'button', className: 'dim-contextClose', 'aria-label': '关闭弹窗',
      disabled: busy, onClick: onCancel,
    }, h(PersonaIcon, { kind: 'close' })));
}

function SourceSelector({ value, busy, onChange }) {
  const options = [
    ['off', '不使用', '不注入任何人设，机器人按默认方式应答。'],
    ['library', '人设库', '使用内置或导入的人设，正文在发送消息时按需读取。'],
    ['inline', '自定义', '为这台机器人单独填写角色名、性格与语气、补充要求。'],
  ];
  return h('fieldset', { className: 'dim-personaSourceSection dim-contextScopeBlock' },
    h('div', { className: 'dim-contextEditorTitle' }, h('span', null, '人设来源')),
    h('div', { className: 'dim-personaSourceOptions' }, options.map(([id, label, hint]) => h('label', {
      key: id,
      className: 'dim-personaSourceOption',
      'data-selected': value === id,
    },
    h('input', {
      type: 'radio', name: 'dim-persona-source', value: id,
      checked: value === id, disabled: busy,
      onChange: () => onChange(id),
    }),
    h('span', { className: 'dim-personaSourceCopy' },
      h('span', { className: 'dim-personaSourceName' }, label),
      h('span', { className: 'dim-personaHint' }, hint))))));
}

function InlineFields({ draft, busy, fieldIdPrefix, onChange }) {
  const toneExample = localizeText(PERSONA_TONE_EXAMPLE);
  const instructionsExample = localizeText(PERSONA_INSTRUCTIONS_EXAMPLE);
  const exampleActions = (key, example) => h('div', { className: 'dim-contextTextActions' },
    h('button', { type: 'button', disabled: busy, onClick: () => onChange(key, example) }, '填入示例'),
    h('button', { type: 'button', disabled: busy, onClick: () => onChange(key, '') }, '清空'));
  return h(React.Fragment, null,
    h(Field, {
      id: `${fieldIdPrefix}-name`,
      label: '角色名',
      hint: '留空时只注入性格与补充要求；角色名会作为机器人自称的一部分。',
      control: h('input', {
        id: `${fieldIdPrefix}-name`, type: 'text', className: 'dim-personaInput',
        value: draft.name, maxLength: PERSONA_NAME_MAX_LENGTH, disabled: busy,
        placeholder: '例如：小助手',
        onChange: (event) => onChange('name', event.target.value),
      }),
    }),
    h(Field, {
      id: `${fieldIdPrefix}-tone`,
      label: '性格与语气',
      hint: '用一两句话描述角色的性格、说话方式和情绪基调。',
      actions: exampleActions('tone', toneExample),
      control: h('textarea', {
        id: `${fieldIdPrefix}-tone`, className: 'dim-personaInput', rows: 2,
        value: draft.tone, maxLength: PERSONA_TONE_MAX_LENGTH, disabled: busy,
        placeholder: toneExample,
        onChange: (event) => onChange('tone', event.target.value),
      }),
    }),
    h(Field, {
      id: `${fieldIdPrefix}-instructions`,
      label: '补充要求',
      hint: '可填写禁忌、示例对话或输出规范；只写正文，插件会自动包进 <dsh_im_persona> 标签。',
      actions: exampleActions('instructions', instructionsExample),
      control: h('textarea', {
        id: `${fieldIdPrefix}-instructions`, className: 'dim-personaInput', rows: 6,
        value: draft.instructions, maxLength: PERSONA_INSTRUCTIONS_MAX_LENGTH, disabled: busy,
        placeholder: instructionsExample,
        onChange: (event) => onChange('instructions', event.target.value),
      }),
    }));
}

function ImportPanel({ form, busy, onChange, onFile, onCancel, onSubmit }) {
  return h('div', { className: 'dim-personaImport dim-contextScopeBlock', 'data-import': 'open' },
    h('div', { className: 'dim-contextEditorTitle' }, h('span', null, '导入人设')),
    h(Field, {
      id: 'dim-persona-import-name',
      label: '人设名称',
      control: h('input', {
        id: 'dim-persona-import-name', type: 'text', className: 'dim-personaInput',
        value: form.name, maxLength: PERSONA_LIBRARY_NAME_MAX_LENGTH, disabled: busy,
        placeholder: '例如：我的助手',
        onChange: (event) => onChange({ name: event.target.value }),
      }),
    }),
    h(Field, {
      id: 'dim-persona-import-text',
      label: '人设正文',
      hint: '粘贴人设正文，或选择本地文件；正文最多 64000 个字符。',
      actions: h('label', { className: 'dim-personaFileButton' },
        h('span', null, '选择文件'),
        h('input', {
          type: 'file', accept: FILE_ACCEPT, disabled: busy,
          className: 'dim-personaFileInput',
          onChange: (event) => {
            const file = event.target.files?.[0];
            if (file) onFile(file);
          },
        })),
      control: h('textarea', {
        id: 'dim-persona-import-text', className: 'dim-personaInput', rows: 8,
        value: form.text, maxLength: PERSONA_LIBRARY_TEXT_MAX_LENGTH, disabled: busy,
        placeholder: '粘贴人设正文，或选择本地 .md / .markdown / .txt 文件',
        onChange: (event) => onChange({ text: event.target.value }),
      }),
    }),
    h('p', { className: 'dim-personaHint' }, '支持 .md / .markdown / .txt 文件，文件只在本机浏览器读取，路径不会离开本机。'),
    h('div', { className: 'dim-personaActions' },
      h('button', { type: 'button', className: 'dim-contextSave', disabled: busy, onClick: onSubmit },
        busy ? '导入中…' : '导入'),
      h('button', { type: 'button', disabled: busy, onClick: onCancel }, '取消导入')));
}

function LibrarySection({
  entries,
  phase,
  error,
  selectedId,
  busy,
  textState,
  importForm,
  renameState,
  removeState,
  onSelect,
  onRetry,
  onOpenImport,
  onImportChange,
  onImportFile,
  onImportCancel,
  onImportSubmit,
  onToggleText,
  onRenameStart,
  onRenameChange,
  onRenameCancel,
  onRenameSubmit,
  onRemoveStart,
  onRemoveCancel,
  onRemoveSubmit,
}) {
  if (phase === 'loading' && entries.length === 0) {
    return h('p', { className: 'dim-personaHint', role: 'status' }, '正在读取人设库…');
  }
  if (phase === 'error' && entries.length === 0) {
    return h('div', { className: 'dim-personaLibraryError' },
      h('p', { className: 'dim-contextError', role: 'alert' }, error ?? '无法读取人设库，请稍后重试。'),
      h('button', { type: 'button', onClick: onRetry, disabled: busy }, '重试'));
  }
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const textReady = textState.id === selectedId && textState.phase === 'ready';
  const editable = selected && !selected.readonly;
  const viewButton = h('button', {
    type: 'button', disabled: busy, onClick: onToggleText,
  }, textState.visible ? '收起全文' : '查看全文');
  const editButtons = editable
    ? h('div', { className: 'dim-personaManageActions' },
      h('button', { type: 'button', disabled: busy, onClick: onRenameStart }, '重命名'),
      removeState.id === selected.id
        ? h(React.Fragment, null,
          h('button', { type: 'button', disabled: busy, onClick: onRemoveSubmit },
            removeState.busy ? '删除中…' : '确认删除人设'),
          h('button', { type: 'button', disabled: busy, onClick: onRemoveCancel }, '取消'))
        : h('button', { type: 'button', disabled: busy, onClick: onRemoveStart }, '删除'))
    : null;
  const readonlyHint = selected?.readonly
    ? (selected.source === 'builtin' ? '内置人设，不可修改' : 'config 人设由插件配置提供，不可修改')
    : null;

  return h('div', { className: 'dim-personaLibrary dim-contextScopeBlock' },
    h('div', { className: 'dim-contextEditorHeader' },
      h('span', { className: 'dim-contextEditorTitle' },
        h('label', { htmlFor: 'dim-persona-library-select' }, '选择人设')),
      h('div', { className: 'dim-contextTextActions' },
        h('button', { type: 'button', disabled: busy || Boolean(importForm), onClick: onOpenImport }, '导入人设'),
        h('button', { type: 'button', disabled: busy || phase === 'loading', onClick: onRetry }, '刷新人设库'))),
    entries.length === 0
      ? h('p', { className: 'dim-personaHint' }, '人设库为空，可以先导入一个人设。')
      : h('select', {
        id: 'dim-persona-library-select',
        className: 'dim-personaSelect',
        value: selectedId,
        disabled: busy || Boolean(importForm),
        onChange: (event) => onSelect(event.target.value),
      },
      h('option', { value: '' }, '未选择人设'),
      ...entries.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name))),
    selected
      ? h('div', { className: 'dim-personaLibrarySelected' },
        h('p', { className: 'dim-personaHint dim-personaLibraryDescription' },
          h('span', { className: 'dim-personaSourceBadge' },
            selected.source === 'builtin' ? '内置人设'
              : selected.source === 'config' ? 'config 人设' : '导入人设'),
          selected.description || '（暂无简介）'),
        h('div', { className: 'dim-contextTextActions' }, viewButton),
        h('div', { className: 'dim-personaLibraryTools' }, readonlyHint, editButtons),
        renameState.id === selected.id
          ? h('div', { className: 'dim-personaRename' },
            h('input', {
              type: 'text', className: 'dim-personaInput', value: renameState.name,
              maxLength: PERSONA_LIBRARY_NAME_MAX_LENGTH, disabled: busy,
              'aria-label': '新名称',
              onChange: (event) => onRenameChange(event.target.value),
            }),
            h('div', { className: 'dim-personaActions' },
              h('button', { type: 'button', disabled: busy, onClick: onRenameSubmit }, '保存名称'),
              h('button', { type: 'button', disabled: busy, onClick: onRenameCancel }, '取消')))
          : null,
        textState.visible
          ? (textState.id === selectedId && textState.phase === 'ready'
            ? h('textarea', {
              className: 'dim-personaPreview dim-personaLibraryText', readOnly: true,
              rows: 10, value: textState.text, 'aria-label': '人设全文',
            })
            : h('p', { className: 'dim-personaHint', role: 'status' },
              textState.phase === 'error'
                ? (textState.error ?? '无法读取人设正文，请稍后重试。')
                : '正在读取人设正文…'))
          : null)
      : null,
    importForm
      ? h(ImportPanel, {
        form: importForm, busy: Boolean(importForm.busy),
        onChange: onImportChange, onFile: onImportFile,
        onCancel: onImportCancel, onSubmit: onImportSubmit,
      })
      : null);
}

function PreviewBlock({ preview, hint, busy }) {
  return h('div', { className: 'dim-personaPreviewBlock dim-contextScopeBlock' },
    h('div', { className: 'dim-contextEditorTitle' }, PREVIEW_LABEL),
    preview
      ? h('textarea', {
        className: 'dim-personaPreview', readOnly: true, rows: 4,
        value: preview, 'aria-label': PREVIEW_LABEL,
      })
      : h('p', { className: 'dim-personaHint' }, hint));
}

function PersonaDialog({ id, persona, disabled, onSave, rpcCall, onClose, returnFocusRef }) {
  const [draft, setDraft] = React.useState(() => normalizePersonaConfig(persona));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [library, setLibrary] = React.useState({ phase: 'idle', entries: [], error: null });
  const [textState, setTextState] = React.useState({ id: '', phase: 'idle', text: '', error: null, visible: false });
  const [importForm, setImportForm] = React.useState(null);
  const [renameState, setRenameState] = React.useState({ id: '', name: '', busy: false });
  const [removeState, setRemoveState] = React.useState({ id: '', busy: false });
  const savingRef = React.useRef(false);
  const dialogRef = React.useRef(null);
  const mountedRef = React.useRef(true);
  const titleId = React.useId();
  const descriptionId = React.useId();
  const fieldIdPrefix = React.useId();
  const busy = disabled || saving;
  const mode = !draft.enabled ? 'off' : draft.source;

  const loadLibrary = React.useCallback(async () => {
    if (typeof rpcCall !== 'function') {
      setLibrary({ phase: 'unavailable', entries: [], error: null });
      return;
    }
    setLibrary((current) => ({
      phase: current.entries.length > 0 ? 'ready' : 'loading',
      entries: current.entries,
      error: null,
    }));
    try {
      const value = await callPersonaRpc(rpcCall, PERSONA_LIBRARY_ENDPOINTS.list);
      if (!mountedRef.current) return;
      setLibrary({ phase: 'ready', entries: Array.isArray(value?.entries) ? value.entries : [], error: null });
    } catch (cause) {
      if (!mountedRef.current) return;
      setLibrary((current) => ({
        phase: 'error', entries: current.entries,
        error: localizeText(typeof cause?.message === 'string' ? cause.message : '无法读取人设库，请稍后重试。'),
      }));
    }
  }, [rpcCall]);

  const loadText = React.useCallback(async (entryId) => {
    if (typeof rpcCall !== 'function' || !entryId) return;
    setTextState({ id: entryId, phase: 'loading', text: '', error: null, visible: true });
    try {
      const value = await callPersonaRpc(rpcCall, PERSONA_LIBRARY_ENDPOINTS.get, { id: entryId });
      if (!mountedRef.current || draft.personaId !== entryId) return;
      setTextState({
        id: entryId, phase: 'ready',
        text: typeof value?.entry?.text === 'string' ? value.entry.text : '',
        error: null, visible: true,
      });
    } catch (cause) {
      if (!mountedRef.current) return;
      setTextState({
        id: entryId, phase: 'error', text: '', visible: true,
        error: localizeText(typeof cause?.message === 'string' ? cause.message : '无法读取人设正文，请稍后重试。'),
      });
    }
  }, [draft.personaId, rpcCall]);

  React.useEffect(() => {
    mountedRef.current = true;
    dialogRef.current?.focus?.();
    const keepFocus = (event) => {
      if (dialogRef.current && !dialogRef.current.contains(event.target)) dialogRef.current.focus();
    };
    globalThis.document?.addEventListener?.('focusin', keepFocus);
    return () => {
      mountedRef.current = false;
      globalThis.document?.removeEventListener?.('focusin', keepFocus);
      queueMicrotask(() => returnFocusRef.current?.focus?.());
    };
  }, [returnFocusRef]);

  React.useEffect(() => {
    if (mode === 'library') void loadLibrary();
  }, [mode, loadLibrary]);

  // 切换选中的人设库条目时，按需拉取该条正文（列表只给元数据）。
  React.useEffect(() => {
    if (mode !== 'library' || !draft.personaId) {
      setTextState({ id: '', phase: 'idle', text: '', error: null, visible: false });
      return;
    }
    setTextState({ id: draft.personaId, phase: 'loading', text: '', error: null, visible: false });
    let disposed = false;
    void (async () => {
      try {
        const value = await callPersonaRpc(rpcCall, PERSONA_LIBRARY_ENDPOINTS.get, { id: draft.personaId });
        if (disposed || !mountedRef.current) return;
        setTextState({
          id: draft.personaId, phase: 'ready',
          text: typeof value?.entry?.text === 'string' ? value.entry.text : '',
          error: null, visible: false,
        });
      } catch (cause) {
        if (disposed || !mountedRef.current) return;
        setTextState({
          id: draft.personaId, phase: 'error', text: '', visible: false,
          error: localizeText(typeof cause?.message === 'string' ? cause.message : '无法读取人设正文，请稍后重试。'),
        });
      }
    })();
    return () => { disposed = true; };
  }, [draft.personaId, mode, rpcCall]);

  const patch = (next) => {
    if (busy || savingRef.current) return;
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  };

  const changeInline = (key, value) => patch({ [key]: value });

  const changeSource = (next) => {
    if (next === 'off') patch({ enabled: false, source: 'inline', personaId: '' });
    else if (next === 'library') patch({ enabled: true, source: 'library' });
    else patch({ enabled: true, source: 'inline', personaId: '' });
  };

  const cancel = () => {
    if (!savingRef.current) onClose();
  };

  const save = async () => {
    if (busy || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    dialogRef.current?.focus?.();
    try {
      const next = validatePersonaConfig(draft);
      if (next.enabled && next.source === 'library'
        && !library.entries.some((entry) => entry.id === next.personaId)) {
        throw new Error('选择的人设不存在，请重新选择。');
      }
      await onSave(next);
      if (mountedRef.current) onClose();
    } catch (cause) {
      if (mountedRef.current) {
        setError(localizeText(typeof cause?.message === 'string' && cause.message
          ? cause.message
          : '人设保存失败，请重试。'));
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const readImportFile = async (file) => {
    const name = String(file?.name ?? '');
    const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (name.lastIndexOf('.') < 0 || !FILE_EXTENSIONS.includes(extension)) {
      setImportForm((current) => ({ ...current, error: '仅支持 .md / .markdown / .txt 文件。' }));
      return;
    }
    try {
      const text = await new Promise((resolve, reject) => {
        const reader = typeof globalThis.FileReader === 'function' ? new globalThis.FileReader() : null;
        if (!reader) {
          reject(new Error('文件读取失败，请重试或直接粘贴正文。'));
          return;
        }
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('文件读取失败，请重试或直接粘贴正文。'));
        reader.readAsText(file);
      });
      setImportForm((current) => ({
        ...current,
        name: (name.slice(0, name.lastIndexOf('.')) || name).slice(0, PERSONA_LIBRARY_NAME_MAX_LENGTH),
        text: text.slice(0, PERSONA_LIBRARY_TEXT_MAX_LENGTH),
        error: null,
      }));
    } catch (cause) {
      setImportForm((current) => ({
        ...current,
        error: localizeText(typeof cause?.message === 'string' ? cause.message : '文件读取失败，请重试或直接粘贴正文。'),
      }));
    }
  };

  const submitImport = async () => {
    if (!importForm || importForm.busy) return;
    setImportForm((current) => ({ ...current, busy: true, error: null }));
    try {
      const value = await callPersonaRpc(rpcCall, PERSONA_LIBRARY_ENDPOINTS.import, {
        name: importForm.name, text: importForm.text,
      });
      if (!mountedRef.current) return;
      setImportForm(null);
      await loadLibrary();
      if (value?.entry?.id) {
        setDraft((current) => ({
          ...current, enabled: true, source: 'library', personaId: value.entry.id,
        }));
      }
    } catch (cause) {
      if (!mountedRef.current) return;
      setImportForm((current) => ({
        ...current, busy: false,
        error: localizeText(typeof cause?.message === 'string' ? cause.message : '导入人设失败，请稍后重试。'),
      }));
    }
  };

  const submitRename = async () => {
    if (renameState.busy) return;
    setRenameState((current) => ({ ...current, busy: true }));
    try {
      await callPersonaRpc(rpcCall, PERSONA_LIBRARY_ENDPOINTS.rename, {
        id: renameState.id, name: renameState.name,
      });
      if (!mountedRef.current) return;
      setRenameState({ id: '', name: '', busy: false });
      await loadLibrary();
    } catch (cause) {
      if (!mountedRef.current) return;
      setRenameState((current) => ({ ...current, busy: false }));
      setError(localizeText(typeof cause?.message === 'string' ? cause.message : '重命名失败，请稍后重试。'));
    }
  };

  const submitRemove = async () => {
    if (removeState.busy) return;
    setRemoveState((current) => ({ ...current, busy: true }));
    try {
      await callPersonaRpc(rpcCall, PERSONA_LIBRARY_ENDPOINTS.remove, { id: removeState.id });
      if (!mountedRef.current) return;
      setRemoveState({ id: '', busy: false });
      setDraft((current) => (current.personaId === draft.personaId
        ? { ...current, personaId: '' }
        : current));
      setTextState({ id: '', phase: 'idle', text: '', error: null, visible: false });
      await loadLibrary();
    } catch (cause) {
      if (!mountedRef.current) return;
      setRemoveState({ id: '', busy: false });
      setError(localizeText(typeof cause?.message === 'string' ? cause.message : '删除失败，请稍后重试。'));
    }
  };

  const selectedEntry = library.entries.find((entry) => entry.id === draft.personaId) ?? null;
  let preview = '';
  let previewHint = '开启并至少填写一项后，此处显示将注入的人设块。';
  if (mode === 'inline') {
    preview = personaBlock(draft);
    if (!preview) previewHint = '开启并至少填写一项后，此处显示将注入的人设块。';
  } else if (mode === 'library') {
    if (!draft.personaId) previewHint = '请先选择人设库中的人设。';
    else if (textState.id === draft.personaId && textState.phase === 'ready') {
      preview = personaBlock({ enabled: true, name: selectedEntry?.name ?? '', text: textState.text });
    } else if (textState.phase === 'error') previewHint = textState.error ?? '无法读取人设正文，请稍后重试。';
    else previewHint = '正在读取人设正文…';
  }

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = dialogRef.current?.querySelectorAll?.(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)',
    );
    if (!controls?.length) {
      event.preventDefault();
      dialogRef.current?.focus?.();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = globalThis.document?.activeElement;
    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === dialogRef.current)) {
      event.preventDefault();
      first.focus();
    }
  };

  const content = h('div', {
    className: 'dim-contextBackdrop dim-personaBackdrop',
    onMouseDown: (event) => { if (event.target === event.currentTarget) cancel(); },
  },
  h('section', {
    id,
    ref: dialogRef,
    className: 'dim-contextDialog dim-personaDialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    'aria-describedby': descriptionId,
    'aria-busy': saving,
    tabIndex: -1,
    onKeyDown,
  },
  h(PersonaHeader, { titleId, descriptionId, busy, onCancel: cancel }),
  h('div', { className: 'dim-personaBody' },
    h(SourceSelector, { value: mode, busy, onChange: changeSource }),
    mode === 'library'
      ? h(LibrarySection, {
        entries: library.entries,
        phase: library.phase,
        error: library.error,
        selectedId: draft.personaId,
        busy,
        textState,
        importForm,
        renameState,
        removeState,
        onSelect: (personaId) => patch({ enabled: true, source: 'library', personaId }),
        onRetry: () => { void loadLibrary(); },
        onOpenImport: () => setImportForm({ name: '', text: '', error: null, busy: false }),
        onImportChange: (next) => setImportForm((current) => ({ ...current, ...next, error: null })),
        onImportFile: (file) => { void readImportFile(file); },
        onImportCancel: () => setImportForm(null),
        onImportSubmit: () => { void submitImport(); },
        onToggleText: () => {
          if (textState.visible) setTextState((current) => ({ ...current, visible: false }));
          else if (textState.id === draft.personaId && textState.phase === 'ready') {
            setTextState((current) => ({ ...current, visible: true }));
          } else {
            void loadText(draft.personaId);
          }
        },
        onRenameStart: () => setRenameState({ id: draft.personaId, name: selectedEntry?.name ?? '', busy: false }),
        onRenameChange: (name) => setRenameState((current) => ({ ...current, name })),
        onRenameCancel: () => setRenameState({ id: '', name: '', busy: false }),
        onRenameSubmit: () => { void submitRename(); },
        onRemoveStart: () => setRemoveState({ id: draft.personaId, busy: false }),
        onRemoveCancel: () => setRemoveState({ id: '', busy: false }),
        onRemoveSubmit: () => { void submitRemove(); },
      })
      : mode === 'inline'
        ? h(InlineFields, { draft, busy, fieldIdPrefix, onChange: changeInline })
        : h('p', { className: 'dim-personaHint' }, '当前不使用人设；保存后该机器人不会注入任何人设内容。'),
    h(PreviewBlock, { preview, hint: previewHint, busy }),
    importForm?.error ? h('p', { className: 'dim-contextError', role: 'alert' }, importForm.error) : null,
    error ? h('p', { className: 'dim-contextError', role: 'alert' }, error) : null),
  h('footer', { className: 'dim-contextFooter' },
    h('button', { type: 'button', disabled: saving, onClick: cancel }, '取消'),
    h('button', {
      type: 'button', className: 'dim-contextSave', disabled: busy,
      onClick: () => { void save(); },
    }, saving ? '保存中…' : '保存'))));

  return globalThis.document?.body ? createPortal(content, document.body) : content;
}

/**
 * 人设设置入口：卡片里一行按钮，点开弹窗编辑。
 *
 * @param props.persona - 当前机器人的 v2 配置；v1 四字段会自动迁移为 inline。
 * @param props.disabled - 机器人连接操作进行中时禁用整个入口。
 * @param props.onSave - `(personaConfig) => Promise<void>`；抛错时弹窗保留并展示原因。
 * @param props.rpcCall - 人设管理 RPC（`personaRpcCall`）；缺省时只保留自定义编辑。
 */
export function PersonaEditor({ persona, disabled = false, onSave, rpcCall }) {
  const [open, setOpen] = React.useState(false);
  const entryRef = React.useRef(null);
  const dialogId = React.useId();
  const statusId = React.useId();
  const saved = normalizePersonaConfig(persona);
  const label = personaLabel(saved);
  const active = personaConfigIsActive(saved);

  return h(React.Fragment, null,
    h('button', {
      type: 'button', ref: entryRef, className: 'dim-contextEntry dim-personaEntry', disabled,
      'aria-label': '人设', 'aria-describedby': statusId,
      'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? dialogId : undefined,
      onClick: () => setOpen(true),
    }, h(PersonaIcon),
    h('span', { className: 'dim-contextLabel' }, '人设'),
    h('span', {
      id: statusId, className: 'dim-contextStatus dim-personaStatus',
      'data-active': active, 'aria-live': 'polite',
    }, label),
    h(PersonaIcon, { kind: 'chevron' })),
    open ? h(PersonaDialog, {
      id: dialogId, persona, disabled, onSave, rpcCall,
      onClose: () => setOpen(false), returnFocusRef: entryRef,
    }) : null);
}

export { PersonaDialog };
