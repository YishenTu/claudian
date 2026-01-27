 Permission System Refactor: Adopt SDK-Native Permission Flow                                                                                                      
                                                                                                                                                                   
 Summary                                                                                                                                                           
                                                                                                                                                                   
 Refactor the permission/approval system to:                                                                                                                       
 1. Use SDK's suggestions → updatedPermissions flow (eliminate parallel permission engine)                                                                         
 2. Change normal mode from SDK default to acceptEdits (auto-approve file edits)                                                                                   
 3. Surface decisionReason and blockedPath in the approval modal                                                                                                   
 4. Simplify ApprovalManager from a stateful class to utility functions                                                                                            
                                                                                                                                                                   
 Step 1: Simplify ApprovalManager to utility functions                                                                                                             
                                                                                                                                                                   
 File: src/core/security/ApprovalManager.ts                                                                                                                        
                                                                                                                                                                   
 - Remove ApprovalManager class entirely (session permissions, checkPermission, approve/deny methods)                                                              
 - Remove types: SessionPermission, AddAllowRuleCallback, AddDenyRuleCallback, PermissionCheckResult                                                               
 - Keep as standalone exports: getActionPattern(), generatePermissionRule(), getActionDescription(), matchesRulePattern(), parseCCPermissionRule() (re-exported    
 from types)                                                                                                                                                       
 - Add new helper: buildPermissionUpdates() — converts user decision + SDK suggestions into PermissionUpdate[]                                                     
                                                                                                                                                                   
 // New helper                                                                                                                                                     
 export function buildPermissionUpdates(                                                                                                                           
   toolName: string,                                                                                                                                               
   input: Record<string, unknown>,                                                                                                                                 
   decision: 'allow' | 'allow-always' | 'deny' | 'deny-always',                                                                                                    
   suggestions?: PermissionUpdate[]                                                                                                                                
 ): PermissionUpdate[] {                                                                                                                                           
   // For "always" decisions: use suggestions with destination overridden to projectSettings,                                                                      
   // or construct our own PermissionUpdate from the action pattern                                                                                                
   // For session decisions: use suggestions as-is or construct with destination: 'session'                                                                        
 }                                                                                                                                                                 
                                                                                                                                                                   
 File: src/core/security/index.ts — Update exports (remove class, keep functions)                                                                                  
                                                                                                                                                                   
 Step 2: Rewrite ClaudianService approval flow                                                                                                                     
                                                                                                                                                                   
 File: src/core/agent/ClaudianService.ts                                                                                                                           
                                                                                                                                                                   
 Remove:                                                                                                                                                           
 - approvalManager field and its initialization (lines 112, 144-167)                                                                                               
 - ccPermissions field (line 114)                                                                                                                                  
 - loadCCPermissions() method (lines 170-172)                                                                                                                      
 - Allow/deny rule callback setup in constructor                                                                                                                   
 - handleNormalModeApproval() method (lines 1422-1488)                                                                                                             
 - isActionApproved() usage                                                                                                                                        
                                                                                                                                                                   
 Rewrite createApprovalCallback() (line 1399):                                                                                                                     
 private createApprovalCallback(): CanUseTool {                                                                                                                    
   return async (toolName, input, options): Promise<PermissionResult> => {                                                                                         
     // 1. Enforce allowedTools restriction (unchanged)                                                                                                            
     if (this.currentAllowedTools !== null) { ... }                                                                                                                
                                                                                                                                                                   
     // 2. Show approval modal (no pre-check — SDK already checked permanent rules)                                                                                
     if (!this.approvalCallback) {                                                                                                                                 
       return { behavior: 'deny', message: 'No approval handler available.' };                                                                                     
     }                                                                                                                                                             
                                                                                                                                                                   
     const description = getActionDescription(toolName, input);                                                                                                    
     const decision = await this.approvalCallback(                                                                                                                 
       toolName, input, description,                                                                                                                               
       options.decisionReason, options.blockedPath                                                                                                                 
     );                                                                                                                                                            
                                                                                                                                                                   
     // 3. Map decision to PermissionResult with updatedPermissions                                                                                                
     if (decision === 'cancel') {                                                                                                                                  
       return { behavior: 'deny', message: 'User interrupted.', interrupt: true };                                                                                 
     }                                                                                                                                                             
                                                                                                                                                                   
     const updatedPermissions = buildPermissionUpdates(                                                                                                            
       toolName, input, decision, options.suggestions                                                                                                              
     );                                                                                                                                                            
                                                                                                                                                                   
     if (decision === 'deny' || decision === 'deny-always') {                                                                                                      
       return { behavior: 'deny', message: 'User denied this action.', updatedPermissions };                                                                       
     }                                                                                                                                                             
                                                                                                                                                                   
     return { behavior: 'allow', updatedInput: input, updatedPermissions };                                                                                        
   };                                                                                                                                                              
 }                                                                                                                                                                 
                                                                                                                                                                   
 Update ApprovalCallback type to include new params:                                                                                                               
 export type ApprovalCallback = (                                                                                                                                  
   toolName: string,                                                                                                                                               
   input: Record<string, unknown>,                                                                                                                                 
   description: string,                                                                                                                                            
   decisionReason?: string,                                                                                                                                        
   blockedPath?: string,                                                                                                                                           
 ) => Promise<'allow' | 'allow-always' | 'deny' | 'deny-always' | 'cancel'>;                                                                                       
                                                                                                                                                                   
 Remove resetSession() call to approvalManager.clearSessionPermissions() (SDK handles session state).                                                              
                                                                                                                                                                   
 Step 3: Remove loadCCPermissions() call from Tab.ts                                                                                                               
                                                                                                                                                                   
 File: src/features/chat/tabs/Tab.ts (line 249)                                                                                                                    
                                                                                                                                                                   
 Remove await service.loadCCPermissions() from initializeTabService() — SDK loads settings.json itself via settingSources.                                         
                                                                                                                                                                   
 Step 4: Change normal → SDK acceptEdits                                                                                                                           
                                                                                                                                                                   
 File: src/core/agent/QueryOptionsBuilder.ts (line 360-375)                                                                                                        
                                                                                                                                                                   
 // Before                                                                                                                                                         
 if (permissionMode === 'yolo') {                                                                                                                                  
   options.permissionMode = 'bypassPermissions';                                                                                                                   
 } else {                                                                                                                                                          
   options.permissionMode = 'default';                                                                                                                             
 }                                                                                                                                                                 
                                                                                                                                                                   
 // After                                                                                                                                                          
 if (permissionMode === 'yolo') {                                                                                                                                  
   options.permissionMode = 'bypassPermissions';                                                                                                                   
 } else {                                                                                                                                                          
   options.permissionMode = 'acceptEdits';                                                                                                                         
 }                                                                                                                                                                 
                                                                                                                                                                   
 File: src/core/agent/ClaudianService.ts (line 1077)                                                                                                               
                                                                                                                                                                   
 // Before                                                                                                                                                         
 const sdkMode = permissionMode === 'yolo' ? 'bypassPermissions' : 'default';                                                                                      
 // After                                                                                                                                                          
 const sdkMode = permissionMode === 'yolo' ? 'bypassPermissions' : 'acceptEdits';                                                                                  
                                                                                                                                                                   
 Step 5: Surface decisionReason and blockedPath in ApprovalModal                                                                                                   
                                                                                                                                                                   
 File: src/shared/modals/ApprovalModal.ts                                                                                                                          
                                                                                                                                                                   
 Add optional fields to ApprovalModalOptions:                                                                                                                      
 export interface ApprovalModalOptions {                                                                                                                           
   showAlwaysAllow?: boolean;                                                                                                                                      
   showAlwaysDeny?: boolean;                                                                                                                                       
   title?: string;                                                                                                                                                 
   decisionReason?: string;                                                                                                                                        
   blockedPath?: string;                                                                                                                                           
 }                                                                                                                                                                 
                                                                                                                                                                   
 In onOpen(), render them between the tool name and description:                                                                                                   
 - decisionReason → muted text block explaining why the SDK is asking                                                                                              
 - blockedPath → monospace path display (if present)                                                                                                               
                                                                                                                                                                   
 File: src/features/chat/controllers/InputController.ts (line 608)                                                                                                 
                                                                                                                                                                   
 Add decisionReason and blockedPath params to handleApprovalRequest(), forward to ApprovalModal options.                                                           
                                                                                                                                                                   
 File: src/features/chat/tabs/Tab.ts (line 889-896)                                                                                                                
                                                                                                                                                                   
 Update setupApprovalCallback() to forward the new params.                                                                                                         
                                                                                                                                                                   
 File: src/style/modals/approval.css                                                                                                                               
                                                                                                                                                                   
 Add styles for .claudian-approval-reason and .claudian-approval-blocked-path.                                                                                     
                                                                                                                                                                   
 Step 6: Update tests                                                                                                                                              
 ┌──────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────┐        
 │                      Test File                       │                                             Changes                                             │        
 ├──────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┤        
 │ tests/unit/core/security/ApprovalManager.test.ts     │ Rewrite: test utility functions only (no class), test buildPermissionUpdates()                  │        
 ├──────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┤        
 │ tests/unit/core/agent/QueryOptionsBuilder.test.ts    │ Change 'default' → 'acceptEdits' in mode mapping assertions                                     │        
 ├──────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┤        
 │ tests/unit/core/agent/ClaudianService.test.ts        │ Remove loadCCPermissions mocks, update approval flow to verify updatedPermissions returned      │        
 ├──────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┤        
 │ tests/integration/core/agent/ClaudianService.test.ts │ Update setPermissionMode assertions ('default' → 'acceptEdits'), remove loadCCPermissions calls │        
 ├──────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┤        
 │ tests/unit/features/chat/tabs/Tab.test.ts            │ Remove loadCCPermissions mocks and related tests                                                │        
 ├──────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┤        
 │ tests/unit/shared/modals/ApprovalModal.test.ts       │ Add test for rendering decisionReason and blockedPath                                           │        
 └──────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────────┘        
 Files Modified                                                                                                                                                    
 ┌──────────────────────────────────────────────────┬──────────────────────────────────────────────────┐                                                           
 │                       File                       │                      Scope                       │                                                           
 ├──────────────────────────────────────────────────┼──────────────────────────────────────────────────┤                                                           
 │ src/core/security/ApprovalManager.ts             │ Major — class → utility functions                │                                                           
 ├──────────────────────────────────────────────────┼──────────────────────────────────────────────────┤                                                           
 │ src/core/security/index.ts                       │ Minor — update exports                           │                                                           
 ├──────────────────────────────────────────────────┼──────────────────────────────────────────────────┤                                                           
 │ src/core/agent/ClaudianService.ts                │ Major — rewrite approval flow                    │                                                           
 ├──────────────────────────────────────────────────┼──────────────────────────────────────────────────┤                                                           
 │ src/core/agent/QueryOptionsBuilder.ts            │ Minor — mode mapping                             │                                                           
 ├──────────────────────────────────────────────────┼──────────────────────────────────────────────────┤                                                           
 │ src/shared/modals/ApprovalModal.ts               │ Moderate — add reason/path UI                    │                                                           
 ├──────────────────────────────────────────────────┼──────────────────────────────────────────────────┤                                                           
 │ src/features/chat/controllers/InputController.ts │ Minor — add params                               │                                                           
 ├──────────────────────────────────────────────────┼──────────────────────────────────────────────────┤                                                           
 │ src/features/chat/tabs/Tab.ts                    │ Minor — remove loadCCPermissions, forward params │                                                           
 ├──────────────────────────────────────────────────┼──────────────────────────────────────────────────┤                                                           
 │ src/style/modals/approval.css                    │ Minor — new styles                               │                                                           
 ├──────────────────────────────────────────────────┼──────────────────────────────────────────────────┤                                                           
 │ 6 test files                                     │ Moderate — update assertions and mocks           │                                                           
 └──────────────────────────────────────────────────┴──────────────────────────────────────────────────┘                                                           
 Verification                                                                                                                                                      
                                                                                                                                                                   
 1. npm run typecheck — no type errors                                                                                                                             
 2. npm run lint — no lint errors                                                                                                                                  
 3. npm run test — all tests pass                                                                                                                                  
 4. npm run build — production build succeeds                                                                                                                      
 5. Manual test in Obsidian:                                                                                                                                       
   - YOLO mode: all tools auto-approved, blocklist still blocks dangerous commands                                                                                 
   - Normal mode: file edits auto-approved (acceptEdits), bash commands prompt approval modal                                                                      
   - "Always allow" → rule persists in .claude/settings.json, not prompted again                                                                                   
   - "Always deny" → rule persists, auto-denied going forward                                                                                                      
   - "Allow once" / "Deny once" → session-scoped, resets on new session                                                                                            
   - Approval modal shows decisionReason when SDK provides it                                                                                                      
                                                                                                                                                                   
 Risks                                                                                                                                                             
                                                                                                                                                                   
 1. SDK updatedPermissions persistence — relies on SDK writing to .claude/settings.json via destination: 'projectSettings'. If the SDK doesn't persist as          
 expected, rules won't survive restarts. Mitigation: verify during manual testing, can add fallback CCSettingsStorage write if needed.                             
 2. acceptEdits behavioral change — file edits no longer prompt in normal mode. This is the intended UX improvement but is a user-facing change.                   
 3. Suggestions format — SDK suggestions may contain setMode or addDirectories types, not just addRules. buildPermissionUpdates() should filter/handle these       
 gracefully. 