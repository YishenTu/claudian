# Test Refactor Plan

## 背景与目标

- 目标 1：提升单元测试覆盖率，并明确其覆盖范围。
- 目标 2：为关键组件建立集成测试集合，便于单独运行与维护。
- 目标 3：测试目录结构映射 `src/`，便于定位与演进。
- 非目标：本次不做 e2e 测试，也不引入新的测试框架。

## 约束与假设

- 保持 Jest 作为唯一测试运行器。
- 现有 `tests/__mocks__` 继续作为共享 mocks 根目录。
- 不改变生产代码逻辑，仅调整测试结构与配置。
- 新增或调整脚本为可选项，不强制改动 `package.json`。

## 目标结构（与 `src/` 镜像）

```
tests/
  __mocks__/
  unit/
    core/
      agent/
      hooks/
      images/
      mcp/
      prompts/
      sdk/
      security/
      storage/
      tools/
      types/
    features/
      chat/
        controllers/
        rendering/
        services/
        state/
      inline-edit/
      mcp/
      settings/
    ui/
      components/
      modals/
      renderers/
      settings/
    utils/
  integration/
    core/
    features/
    main.test.ts
```

## 单元/集成划分原则

- **Unit**：纯函数/小模块/单一组件逻辑；允许 mocks 但不跨多个业务组件。
- **Integration**：跨模块协作、依赖注入较多、涵盖重要业务流程或 I/O 行为的组件。

## 集成测试范围（建议）

- `ClaudianService`（核心代理服务，串联 SDK、hooks、security）
- `ClaudianView`（核心视图，涉及 UI 组装与状态流）
- `main`（插件入口，影响整体启动与注册流程）
- `mcp`（MCP 相关服务与协议交互）
- `imagePersistence`（消息持久化涉及图片数据清理）

> 如果你有更明确的“重要组件”名单，请在迁移前确认这份清单。

## 文件迁移映射（建议版）

| Current | Target |
| --- | --- |
| tests/ClaudianService.test.ts | tests/integration/core/agent/ClaudianService.test.ts |
| tests/ClaudianView.test.ts | tests/integration/features/chat/ClaudianView.test.ts |
| tests/mcp.test.ts | tests/integration/features/mcp/mcp.test.ts |
| tests/main.test.ts | tests/integration/main.test.ts |
| tests/imagePersistence.test.ts | tests/integration/features/chat/imagePersistence.test.ts |
| tests/ApprovalModal.test.ts | tests/unit/ui/modals/ApprovalModal.test.ts |
| tests/AskUserQuestionPanel.test.ts | tests/unit/ui/components/AskUserQuestionPanel.test.ts |
| tests/AsyncSubagentManager.test.ts | tests/unit/features/chat/services/AsyncSubagentManager.test.ts |
| tests/BashPathValidator.test.ts | tests/unit/core/security/BashPathValidator.test.ts |
| tests/ConversationController.test.ts | tests/unit/features/chat/controllers/ConversationController.test.ts |
| tests/DiffRenderer.test.ts | tests/unit/ui/renderers/DiffRenderer.test.ts |
| tests/FileContext.test.ts | tests/unit/ui/components/FileContext.test.ts |
| tests/InlineEditModal.test.ts | tests/unit/ui/modals/InlineEditModal.test.ts |
| tests/InlineEditService.test.ts | tests/unit/features/inline-edit/InlineEditService.test.ts |
| tests/InputController.test.ts | tests/unit/features/chat/controllers/InputController.test.ts |
| tests/InstructionModeManager.test.ts | tests/unit/ui/components/InstructionModeManager.test.ts |
| tests/InstructionRefineService.test.ts | tests/unit/features/chat/services/InstructionRefineService.test.ts |
| tests/MessageRenderer.test.ts | tests/unit/features/chat/rendering/MessageRenderer.test.ts |
| tests/PlanApprovalPanel.test.ts | tests/unit/ui/components/PlanApprovalPanel.test.ts |
| tests/SelectionController.test.ts | tests/unit/features/chat/controllers/SelectionController.test.ts |
| tests/SlashCommandManager.test.ts | tests/unit/ui/components/SlashCommandManager.test.ts |
| tests/StreamController.test.ts | tests/unit/features/chat/controllers/StreamController.test.ts |
| tests/SubagentRenderer.test.ts | tests/unit/ui/renderers/SubagentRenderer.test.ts |
| tests/TitleGenerationService.test.ts | tests/unit/features/chat/services/TitleGenerationService.test.ts |
| tests/WriteEditRenderer.test.ts | tests/unit/ui/renderers/WriteEditRenderer.test.ts |
| tests/imageCache.test.ts | tests/unit/core/images/imageCache.test.ts |
| tests/imageHydration.test.ts | tests/unit/core/images/imageHydration.test.ts |
| tests/storage.test.ts | tests/unit/core/storage/storage.test.ts |
| tests/systemPrompt.test.ts | tests/unit/core/prompts/systemPrompt.test.ts |
| tests/types.test.ts | tests/unit/core/types/types.test.ts |
| tests/utils.test.ts | tests/unit/utils/utils.test.ts |

## 路径别名（推荐）

为避免深层相对路径问题，建议引入：

- `@/` → `src/`
- `@test/` → `tests/`

示例（tsconfig）：

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@test/*": ["tests/*"]
    }
  }
}
```

示例（jest moduleNameMapper）：

```js
module.exports = {
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@test/(.*)$': '<rootDir>/tests/$1',
    '^@anthropic-ai/claude-agent-sdk$': '<rootDir>/tests/__mocks__/claude-agent-sdk.ts',
    '^obsidian$': '<rootDir>/tests/__mocks__/obsidian.ts'
  }
};
```

## Jest 配置重构（推荐）

引入 projects 将 unit 与 integration 分离：

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/unit/**/*.test.ts']
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts']
    }
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }]
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage'
};
```

## 执行步骤（建议顺序）

1) 创建目录结构（unit / integration / 子目录）。
2) 使用 `git mv` 迁移测试文件，保持历史。
3) 更新测试内 import：
   - `../src/...` → `@/...`（推荐）
   - `./__mocks__/...` → `@test/__mocks__/...`
4) 更新 `jest.config.js`：
   - projects + `moduleNameMapper` + 新 `testMatch`。
5) 更新 `tsconfig.json`：
   - 添加 `paths`。
6) （可选）更新文档（`CLAUDE.md` / README）说明新结构。

## 验证建议

- 运行单元测试：
  - `npm run test -- --selectProjects unit`
- 运行集成测试：
  - `npm run test -- --selectProjects integration`
- 运行单元覆盖率：
  - `npm run test:coverage -- --selectProjects unit`
- 再跑静态检查：
  - `npm run lint`
  - `npm run typecheck`

## 风险与回滚策略

- 风险 1：路径别名配置遗漏导致 Jest 无法解析。
  - 回滚：暂时保留相对路径，先完成目录迁移再逐步引入别名。
- 风险 2：集成测试范围过大导致运行慢。
  - 回滚：将部分测试降级到 unit，或拆分为更小模块。
- 风险 3：迁移后测试遗漏。
  - 回滚：按旧文件名逐一比对，确保所有测试文件被迁移。
