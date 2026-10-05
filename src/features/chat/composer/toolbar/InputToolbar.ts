import { ContextUsageMeter } from '@/features/chat/composer/toolbar/ContextUsageMeter';
import { EffortSelector } from '@/features/chat/composer/toolbar/EffortSelector';
import { ModelSelector } from '@/features/chat/composer/toolbar/ModelSelector';
import { ModeSelector } from '@/features/chat/composer/toolbar/ModeSelector';
import { PermissionToggle } from '@/features/chat/composer/toolbar/PermissionToggle';
import { ServiceTierToggle } from '@/features/chat/composer/toolbar/ServiceTierToggle';
import { ToolbarMenuGroup, type ToolbarMenus } from '@/features/chat/composer/toolbar/ToolbarMenu';
import type { ToolbarCallbacks } from '@/features/chat/composer/toolbar/types';

export function createInputToolbar(
  parentEl: HTMLElement,
  callbacks: ToolbarCallbacks,
): {
  modelSelector: ModelSelector;
  modeSelector: ModeSelector;
  effortSelector: EffortSelector;
  contextUsageMeter: ContextUsageMeter;
  menus: ToolbarMenus;
  permissionToggle: PermissionToggle;
  serviceTierToggle: ServiceTierToggle;
} {
  const menuGroup = new ToolbarMenuGroup();
  const modelSelector = new ModelSelector(parentEl, callbacks, menuGroup);
  // The read-only context gauge sits right after the model picker.
  const contextUsageMeter = new ContextUsageMeter(parentEl);
  const effortSelector = new EffortSelector(modelSelector, callbacks);
  const serviceTierToggle = new ServiceTierToggle(modelSelector, callbacks);
  const modeSelector = new ModeSelector(parentEl, callbacks, menuGroup);
  // Permission is the last control; CSS pushes it to the toolbar's far end.
  const permissionToggle = new PermissionToggle(parentEl, callbacks, menuGroup);

  return {
    modelSelector,
    modeSelector,
    effortSelector,
    serviceTierToggle,
    contextUsageMeter,
    menus: menuGroup,
    permissionToggle,
  };
}
