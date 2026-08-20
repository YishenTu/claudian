import path from 'node:path';

import * as ts from 'typescript';

import * as protocol from '../src/index';

const EXPECTED_VALUE_EXPORTS = [
  'COLLAB_CONTROL_OPERATION_CODECS',
  'COLLAB_ERROR_CODES',
  'COLLAB_LIMITS',
  'COLLAB_MAIN_REF',
  'COLLAB_MEMBER_REF_PREFIX',
  'COLLAB_PROTOCOL_VERSION',
  'CollabError',
  'collabControlOperationCodec',
  'collabErrorGroup',
  'collabMemberRef',
  'decodeCollabProtocolEnvelope',
  'isCollabGitOid',
  'isCollabMemberId',
  'isCollabOpaqueId',
  'isCollabProjectId',
  'parseCollabMemberMentions',
  'parseCollabTicketReferences',
  'sanitizeCollabDiagnosticContext',
  'scanCollabTicketReferences',
] as const;

const EXPECTED_TYPE_EXPORTS = [
  'AcceptRequest', 'AcceptResponse', 'ChangeTicketStatusRequest',
  'CollabChangeRequest', 'CollabChangedFile', 'CollabComment', 'CollabCommentId',
  'CollabCommentPage', 'CollabControlOperation', 'CollabControlOperationCodec',
  'CollabControlOperationDefinition', 'CollabControlOperationMap',
  'CollabDecodeFailure', 'CollabDecodeResult', 'CollabDiagnosticContext',
  'CollabDiagnosticValue', 'CollabError', 'CollabErrorCode', 'CollabErrorGroup',
  'CollabErrorOptions',
  'CollabFileChangeKind', 'CollabGitOid', 'CollabIdempotencyKey',
  'CollabIsoTimestamp', 'CollabMember', 'CollabMemberId',
  'CollabMemberMentionTarget', 'CollabMemberStatus', 'CollabMutationContext',
  'CollabOperationId', 'CollabParsedTicketReference', 'CollabProjectId',
  'CollabProtocolEnvelope', 'CollabProtocolVersion', 'CollabRecoveryAction',
  'CollabRelativePath', 'CollabRequestDetail', 'CollabRequestId',
  'CollabRequestStatus', 'CollabRequestTicketOperation',
  'CollabRequestTicketRelation', 'CollabResolvingTicketExpectation',
  'CollabReviewCondition', 'CollabRole', 'CollabTicketAcceptedRelation',
  'CollabTicketAcceptedRelationPage', 'CollabTicketComment',
  'CollabTicketCommentId', 'CollabTicketCommentPage',
  'CollabTicketCommitRelationKind',
  'CollabTicketDetail', 'CollabTicketId', 'CollabTicketPage',
  'CollabTicketReferenceParseFailureReason', 'CollabTicketReferenceParseResult',
  'CollabTicketReferenceScanResult', 'CollabTicketReferenceToken',
  'CollabTicketRelationId', 'CollabTicketStatus', 'CollabTicketSummary',
  'CreateCommentRequest', 'CreateCommentResponse', 'CreateTicketCommentRequest',
  'CreateTicketCommentResponse', 'CreateTicketRequest', 'CreateTicketResponse',
  'EnsureMyRequestRequest', 'EnsureMyRequestResponse', 'GetRequestRequest',
  'GetTicketRequest', 'ListRequestCommentsRequest',
  'ListTicketAcceptedRelationsRequest', 'ListTicketCommentsRequest',
  'ListTicketsRequest', 'TicketMutationResponse',
  'UpdateMyRequestMetadataRequest', 'UpdateMyRequestMetadataResponse',
  'UpdateTicketContentRequest',
] as const;

const EXPECTED_OPERATIONS = [
  'getRequest',
  'listRequestComments',
  'ensureMyRequest',
  'createComment',
  'listTickets',
  'getTicket',
  'listTicketComments',
  'listTicketAcceptedRelations',
  'createTicket',
  'updateTicketContent',
  'createTicketComment',
  'closeTicket',
  'reopenTicket',
  'updateMyRequestMetadata',
  'acceptRequest',
] as const;

function exportedTypeNames(): string[] {
  const packageRoot = path.resolve(__dirname, '..');
  const configPath = path.join(packageRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const source = program.getSourceFile(path.join(packageRoot, 'src/index.ts'));
  const moduleSymbol = source && program.getTypeChecker().getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error('Unable to inspect the package root exports');
  const checker = program.getTypeChecker();
  return checker.getExportsOfModule(moduleSymbol)
    .filter((symbol) => {
      const target = (symbol.flags & ts.SymbolFlags.Alias) === 0
        ? symbol
        : checker.getAliasedSymbol(symbol);
      return (target.flags & ts.SymbolFlags.Type) !== 0;
    })
    .map(symbol => symbol.getName())
    .sort();
}

describe('package public exports', () => {
  it('exposes exactly the allowlisted runtime surface', () => {
    expect(Object.keys(protocol).sort()).toEqual([...EXPECTED_VALUE_EXPORTS]);
  });

  it('exposes exactly the allowlisted type surface', () => {
    expect(exportedTypeNames()).toEqual([...EXPECTED_TYPE_EXPORTS].sort());
  });

  it('exposes one exact canonical operation registry', () => {
    const operations = Object.keys(protocol.COLLAB_CONTROL_OPERATION_CODECS);
    expect(operations).toEqual(EXPECTED_OPERATIONS);
    for (const operation of operations) {
      const codec = protocol.COLLAB_CONTROL_OPERATION_CODECS[
        operation as protocol.CollabControlOperation
      ];
      expect(typeof codec.decodeRequest).toBe('function');
      expect(typeof codec.decodeResponse).toBe('function');
    }
  });

  it('keeps the wire version as a positive integer', () => {
    expect(Number.isInteger(protocol.COLLAB_PROTOCOL_VERSION)).toBe(true);
    expect(protocol.COLLAB_PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
