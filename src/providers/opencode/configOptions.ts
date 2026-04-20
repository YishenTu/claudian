import type {
  AcpSessionConfigSelectGroup,
  AcpSessionConfigSelectOption,
  AcpSessionConfigSelectOptions,
} from '../acp';

export function flattenOpencodeSelectOptions(
  options: AcpSessionConfigSelectOptions,
): AcpSessionConfigSelectOption[] {
  if (options.length === 0) {
    return [];
  }

  const first = options[0];
  if (isSelectGroup(first)) {
    return (options as AcpSessionConfigSelectGroup[]).flatMap((group) => group.options);
  }

  return options as AcpSessionConfigSelectOption[];
}

function isSelectGroup(
  option: AcpSessionConfigSelectOption | AcpSessionConfigSelectGroup,
): option is AcpSessionConfigSelectGroup {
  return 'options' in option;
}
