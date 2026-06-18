// Settings schema types. A plugin declares a typed field schema; the platform
// renders a uniform UI from it. The discriminated `type` field drives both the
// render path and per-field TypeScript inference.

export type SettingSpec =
  | {
      type: 'string';
      label: string;
      default: string;
      hint?: string;
      placeholder?: string;
    }
  | {
      type: 'number';
      label: string;
      default: number;
      hint?: string;
      step?: number;
      min?: number;
      max?: number;
    }
  | {
      type: 'boolean';
      label: string;
      default: boolean;
      hint?: string;
    }
  | {
      type: 'enum';
      label: string;
      default: string;
      options: { value: string; label: string }[];
      hint?: string;
    };

export type SettingsSchema = Record<string, SettingSpec>;

// Identity pass-through, so callers write `defineSettings({...} as const)` and
// get full literal inference without restating the type.
export function defineSettings<T extends SettingsSchema>(schema: T): T {
  return schema;
}

// Default value for a spec. Centralized so the store and UI agree on "unset".
export function specDefault(spec: SettingSpec): string | number | boolean {
  return spec.default;
}
