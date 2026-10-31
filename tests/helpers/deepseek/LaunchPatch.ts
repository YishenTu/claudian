import type { DeepSeekPresetPlugin } from '@/providers/deepseek/runtime/DeepSeekPresetPlugins';

/** Native launch JSON inspected by the process peer and artifact contract tests. */
export interface LaunchPlugin extends DeepSeekPresetPlugin {
  config: {
    id: string;
    plugins: LaunchPlugin[];
    promptDirectory: string;
    codeModeFile: string;
    stateFile: string;
    readyFile: string;
    spillRoot: string;
    sessionToolsFile: string;
    endpointFile: string;
    allow?: string[];
    [field: string]: unknown;
  };
}
export interface LaunchPatchEntry {
  id?: string;
  insert?: LaunchPlugin[];
}
