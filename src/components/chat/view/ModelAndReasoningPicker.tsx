import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, Loader2, Search } from 'lucide-react';

import { primaryModelSelector } from '../../../../shared/model-selectors';
import { cn } from '../../../utils/cn';
import type { ProviderModelOption } from '../../../types/app';

import {
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_OPTIONS,
  type ReasoningEffort,
} from './reasoningEffort';

const DEFAULT_MODEL_VALUE = 'default';

type ModelAndReasoningPickerProps = {
  /** Session-scoped selection: raw model id, `profile:*` preset, or `default`. */
  value: string;
  /** Model the session runtime last reported; wins for display when present. */
  currentModel?: string;
  /** Preset catalog used to resolve the current/default display label. */
  presetOptions: ProviderModelOption[];
  /** Runtime model metadata, including the exact efforts GJC exposes per model. */
  modelOptions: ProviderModelOption[];
  /**
   * Whether `modelOptions` is the runtime's answer (true, even when empty:
   * nobody signed in) or missing because the runtime could not be asked. Only
   * a known answer dims the models it does not list.
   */
  availabilityKnown?: boolean;
  loading?: boolean;
  onSelect: (modelId: string) => Promise<unknown> | unknown;
  reasoningEffort: ReasoningEffort;
  onSelectReasoningEffort: (value: ReasoningEffort) => void;
};

const compactModel = (modelId: string): string => modelId.split('/').pop() ?? modelId;

export const modelDisplayLabel = (
  modelId: string | undefined,
  modelOptions: ProviderModelOption[],
): string | undefined => {
  if (!modelId) return undefined;
  return modelOptions.find((option) => option.value === modelId)?.label || compactModel(modelId);
};

const providerOf = (modelId: string): string => (
  modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : ''
);

/**
 * Preset role selectors read `provider/model:effort`. Reasoning is chosen by
 * the second step of this picker, so the model list must offer only the base
 * model id — otherwise every effort variant shows up as its own "model".
 */
export const stripEffortSuffix = (selector: string): string =>
  (primaryModelSelector(selector) ?? '')
    .replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, '');

/** Display order requested for provider groups; unlisted providers follow alphabetically. */
const PROVIDER_ORDER = ['openai-codex', 'cursor', 'anthropic', 'kimi-code', 'zai', 'xai', 'grok-build'];

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  'openai-codex': 'ChatGPT',
  cursor: 'Cursor',
  anthropic: 'Anthropic',
  'kimi-code': 'Kimi Code',
  zai: 'Z.AI',
  xai: 'xAI',
  'grok-build': 'Grok Build',
  'alibaba-token-plan': 'Alibaba Coding Plan',
  'glm-zcode': 'GLM Coding Plan',
};

export const providerDisplayLabel = (provider: string): string =>
  PROVIDER_LABELS[provider] ?? provider
    .split('-')
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');

const providerRank = (provider: string): number => {
  const index = PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? PROVIDER_ORDER.length : index;
};

export type SessionModelChoice = { value: string; label: string; available: boolean };
export type SessionModelGroup = { group: string; available: boolean; models: SessionModelChoice[] };

/**
 * Every model the presets name, grouped by provider, with the runtime's word
 * on which of them can run with the stored subscriptions. A model the
 * runtime did not list is still shown - dimmed and unselectable - so a
 * person sees what signing in to that provider would unlock, instead of a
 * provider that silently has no models. When the runtime could not be asked
 * (`availabilityKnown` false: no `MODELS`, worker startup failure, stale
 * cache) nothing is dimmed; the preset selectors keep the picker usable.
 */
export function deriveSessionModelOptions(
  modelOptions: ProviderModelOption[],
  presetOptions: ProviderModelOption[] = [],
  availabilityKnown = false,
): SessionModelGroup[] {
  const seen = new Map<string, SessionModelChoice>();
  for (const option of modelOptions) {
    const model = stripEffortSuffix(option.value.trim());
    if (model.includes('/') && !seen.has(model)) seen.set(model, { value: model, label: option.label || compactModel(model), available: true });
  }
  for (const option of presetOptions) {
    for (const selector of Object.values(option.roles ?? {})) {
      // A model selector always reads provider/model; anything else (e.g. a
      // profile name leaking out of config.yml) is not a selectable model.
      if (typeof selector !== 'string') continue;
      const model = stripEffortSuffix(selector.trim());
      if (model.includes('/') && !seen.has(model)) seen.set(model, { value: model, label: compactModel(model), available: !availabilityKnown });
    }
  }
  const groups = new Map<string, SessionModelChoice[]>();
  for (const model of [...seen.values()].sort((left, right) => left.label.localeCompare(right.label))) {
    const group = providerOf(model.value) || 'other';
    const bucket = groups.get(group);
    if (bucket) bucket.push(model);
    else groups.set(group, [model]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => providerRank(left) - providerRank(right) || left.localeCompare(right))
    .map(([group, models]) => ({ group, available: models.some((model) => model.available), models }));
}

/**
 * Narrows the provider/model groups to a query. A provider whose name matches
 * keeps every model; otherwise a group keeps the models whose label or id
 * match. Groups left with nothing disappear, so the provider column is the
 * list of places where something matched.
 */
export function filterSessionModelGroups(groups: SessionModelGroup[], query: string): SessionModelGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  const matches = (text: string) => text.toLowerCase().includes(needle);
  return groups.flatMap((group) => {
    if (matches(providerDisplayLabel(group.group)) || matches(group.group)) return [group];
    const models = group.models.filter((model) => matches(model.label) || matches(model.value));
    return models.length ? [{ ...group, models }] : [];
  });
}

/**
 * Resolves which model id the trigger button should display: the live session
 * report wins, then an explicit raw selection, then the default-role model of
 * the selected (or current) preset.
 */
export function resolveDisplayModel(
  value: string,
  currentModel: string | undefined,
  presetOptions: ProviderModelOption[],
): string | undefined {
  if (currentModel?.trim()) return stripEffortSuffix(currentModel.trim());
  if (value && value !== DEFAULT_MODEL_VALUE && !value.startsWith('profile:')) return value;
  const preset = presetOptions.find((option) => option.value === value)
    ?? presetOptions.find((option) => option.value === DEFAULT_MODEL_VALUE);
  const role = preset?.roles?.default;
  if (!role) return undefined;
  if (role.includes('/')) return stripEffortSuffix(role);
  // A profile-name reference (no provider prefix): resolve one level through
  // the referenced preset's own default role.
  const referenced = presetOptions.find((option) => option.value === `profile:${role}`)?.roles?.default;
  return referenced?.includes('/') ? stripEffortSuffix(referenced) : undefined;
}

export function reasoningOptionsForModel(
  modelId: string | undefined,
  modelOptions: ProviderModelOption[],
): ReasoningEffort[] {
  if (!modelId) return [];
  const model = modelOptions.find((option) => option.value === modelId);
  const supported = model?.effort?.values
    .map((option) => option.value)
    .filter((value): value is ReasoningEffort =>
      value !== 'default' && value !== 'off' && value in REASONING_EFFORT_LABELS,
    ) ?? [];
  return supported.length > 0 ? ['default', 'off', ...new Set(supported)] : [];
}

export function displayedReasoningEffort(
  selected: ReasoningEffort,
  modelId: string | undefined,
  modelOptions: ProviderModelOption[],
): ReasoningEffort {
  if (selected !== 'default') return selected;
  const runtimeDefault = modelOptions.find((option) => option.value === modelId)?.effort?.default;
  return runtimeDefault && runtimeDefault in REASONING_EFFORT_LABELS
    ? runtimeDefault as ReasoningEffort
    : selected;
}

export async function persistChosenModel(
  modelId: string,
  currentValue: string,
  onSelect: (modelId: string) => Promise<unknown> | unknown,
): Promise<void> {
  if (modelId !== currentValue) await onSelect(modelId);
}

/**
 * One composer control for the two settings that define the next answer:
 * the session's chat model and its reasoning effort. The popup is a cascading
 * provider → model → reasoning panel: picking a provider only navigates,
 * picking a model persists it immediately, and picking a reasoning level
 * finishes the flow. The separate preset control still owns the full
 * multi-role agent configuration.
 */
export default function ModelAndReasoningPicker({
  value,
  currentModel,
  presetOptions,
  modelOptions,
  availabilityKnown = false,
  loading = false,
  onSelect,
  reasoningEffort,
  onSelectReasoningEffort,
}: ModelAndReasoningPickerProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  /** Provider column navigation; null follows the currently selected model. */
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  /** Model whose reasoning levels the third column offers. */
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  const [popupPosition, setPopupPosition] = useState({ bottom: 0, left: 0 });
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const allGroups = useMemo(
    () => deriveSessionModelOptions(modelOptions, presetOptions, availabilityKnown),
    [modelOptions, presetOptions, availabilityKnown],
  );
  const groups = useMemo(() => filterSessionModelGroups(allGroups, query), [allGroups, query]);
  const displayModel = resolveDisplayModel(value, currentModel, presetOptions);
  const displayModelLabel = modelDisplayLabel(displayModel, modelOptions);
  const isRawSelection = value !== DEFAULT_MODEL_VALUE && !value.startsWith('profile:');
  const displayedEffort = displayedReasoningEffort(reasoningEffort, displayModel, modelOptions);
  const reasoningLabel = REASONING_EFFORT_LABELS[displayedEffort];

  /** Model id the check mark in the model column belongs to. */
  const selectedModelId = isRawSelection ? stripEffortSuffix(value) : displayModel;
  const selectedProvider = selectedModelId ? providerOf(selectedModelId) : null;
  const shownProvider = activeProvider
    ?? (selectedProvider && groups.some((entry) => entry.group === selectedProvider)
      ? selectedProvider
      : groups[0]?.group ?? null);
  const shownModels = groups.find((entry) => entry.group === shownProvider)?.models ?? [];
  const reasoningModelId = activeModel === DEFAULT_MODEL_VALUE
    ? displayModel
    : activeModel ?? selectedModelId;
  const reasoningOptions = reasoningOptionsForModel(reasoningModelId ?? undefined, modelOptions);

  // The composer form clips its children (overflow-hidden rounded corners), so
  // the popup must escape through a body portal with fixed positioning.
  useEffect(() => {
    if (!open) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      setPopupPosition({
        bottom: window.innerHeight - rect.top + 8,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 448 - 8)),
      });
    }
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popupRef.current?.contains(target)) setOpen(false);
    };
    const closeForEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      returnFocus.current = true;
      // Clear the filter before restoring focus: no matches disables the trigger.
      setQuery('');
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeForEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeForEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setActiveProvider(null);
      setActiveModel(null);
      setQuery('');
      if (returnFocus.current) triggerRef.current?.focus();
      returnFocus.current = false;
      return;
    }
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  const chooseModel = async (modelId: string) => {
    // Choosing a model is the consequential action. Persist it before the
    // optional reasoning choice so dismissing the popup cannot silently leave
    // the previous runtime model active.
    setSelecting(true);
    try {
      await persistChosenModel(modelId, value, onSelect);
    } finally {
      setSelecting(false);
    }
    setActiveModel(modelId);
    const resolvedModel = modelId === DEFAULT_MODEL_VALUE ? displayModel : modelId;
    if (reasoningOptionsForModel(resolvedModel, modelOptions).length === 0) {
      onSelectReasoningEffort('default');
      setOpen(false);
    }
  };

  const chooseReasoning = (effort: ReasoningEffort) => {
    onSelectReasoningEffort(effort);
    setOpen(false);
  };

  /** "Use current configuration" is a full reset: model and reasoning together. */
  const chooseDefault = async () => {
    setSelecting(true);
    try {
      await persistChosenModel(DEFAULT_MODEL_VALUE, value, onSelect);
    } finally {
      setSelecting(false);
    }
    onSelectReasoningEffort('default');
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative w-fit max-w-full shrink-0 sm:max-w-56">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={loading || selecting || groups.length === 0}
        className="flex h-8 w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        aria-label={t('input.modelReasoning.label')}
        aria-busy={loading || selecting}
        aria-expanded={open}
        title={`${displayModel ?? t('input.modelReasoning.defaultModel')} · ${reasoningLabel}`}
      >
        {(loading || selecting) && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
        <span className="min-w-0 truncate text-left">
          {loading && !displayModelLabel ? (
            <span className="block h-3 w-24 rounded bg-muted" aria-hidden />
          ) : displayModelLabel ?? t('input.modelReasoning.defaultModel')}
        </span>
        <span className="shrink-0 text-border" aria-hidden>·</span>
        <span className="shrink-0 whitespace-nowrap">{reasoningLabel}</span>
        <ChevronDown className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open && createPortal(
        <div
          ref={popupRef}
          className="fixed z-80 w-md max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
          style={{ bottom: popupPosition.bottom, left: popupPosition.left }}
        >
          <button
            type="button"
            onClick={() => { void chooseDefault(); }}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-accent',
              !isRawSelection && 'bg-accent/70',
            )}
          >
            <span className="min-w-0 flex-1 truncate font-medium">
              {t('input.modelReasoning.defaultModel')}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {t('input.modelReasoning.currentConfiguration')}
            </span>
            {!isRawSelection && <Check className="size-3.5 shrink-0 text-primary" />}
          </button>

          <div className="relative mt-1 px-1 pb-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActiveProvider(null); }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || event.defaultPrevented || !query) return;
                event.preventDefault();
                event.stopPropagation();
                setQuery('');
              }}
              placeholder={t('input.modelReasoning.search')}
              aria-label={t('input.modelReasoning.search')}
              className="h-7 w-full rounded-md border border-input bg-background pr-2 pl-7 text-xs outline-hidden placeholder:text-muted-foreground focus:border-ring"
            />
          </div>

          {groups.length === 0 && (
            <p className="px-2.5 py-6 text-center text-[11px] text-muted-foreground" role="status">
              {t('input.modelReasoning.noMatches')}
            </p>
          )}

          <div className={cn('flex divide-x divide-border/60 border-t border-border/60 pt-1', groups.length === 0 && 'hidden')}>
            <div className="min-w-0 flex-[1.1] pr-1" role="listbox" aria-label={t('input.modelReasoning.providerTitle')}>
              <p className="px-2.5 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t('input.modelReasoning.providerTitle')}
              </p>
              <div className="max-h-64 space-y-0.5 overflow-y-auto">
                {groups.map(({ group, available }) => {
                  const isShown = group === shownProvider;
                  const holdsSelection = group === selectedProvider;
                  return (
                    <button
                      key={group}
                      type="button"
                      role="option"
                      aria-selected={isShown}
                      data-available={available}
                      onClick={() => setActiveProvider(group)}
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-accent',
                        isShown && 'bg-accent/70',
                        !available && 'text-muted-foreground/60',
                      )}
                      title={available
                        ? providerDisplayLabel(group)
                        : t('input.modelReasoning.signInRequired', { provider: providerDisplayLabel(group) })}
                    >
                      <span className="min-w-0 flex-1 truncate">{providerDisplayLabel(group)}</span>
                      {holdsSelection && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />}
                      <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="min-w-0 flex-[1.2] px-1" role="listbox" aria-label={t('input.modelReasoning.modelTitle')}>
              <p className="px-2.5 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t('input.modelReasoning.modelTitle')}
              </p>
              <div className="max-h-64 space-y-0.5 overflow-y-auto">
                {shownModels.map((model) => {
                  const isSelected = model.value === selectedModelId;
                  return (
                    <button
                      key={model.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={!model.available || undefined}
                      disabled={!model.available}
                      onClick={() => { void chooseModel(model.value); }}
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs',
                        model.available ? 'hover:bg-accent' : 'cursor-not-allowed text-muted-foreground/50',
                        isSelected && 'bg-accent/70',
                      )}
                      title={model.available
                        ? model.value
                        : t('input.modelReasoning.signInRequired', { provider: providerDisplayLabel(providerOf(model.value)) })}
                    >
                      <span className="min-w-0 flex-1 truncate">{model.label}</span>
                      {isSelected && <Check className="size-3.5 shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="min-w-0 flex-[0.9] pl-1" role="listbox" aria-label={t('input.modelReasoning.reasoningTitle')}>
              <p className="px-2.5 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t('input.modelReasoning.reasoningTitle')}
              </p>
              <div className="max-h-64 space-y-0.5 overflow-y-auto">
                {reasoningOptions.length === 0 ? (
                  <p className="px-2.5 py-1.5 text-xs text-muted-foreground/60" aria-hidden>–</p>
                ) : REASONING_EFFORT_OPTIONS
                  .filter((option) => reasoningOptions.includes(option.value))
                  .map((option) => {
                    const isSelected = option.value === reasoningEffort;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => chooseReasoning(option.value)}
                        className={cn(
                          'flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-accent',
                          isSelected && 'bg-accent/70',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        {isSelected && <Check className="size-3.5 shrink-0 text-primary" />}
                      </button>
                    );
                  })}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
