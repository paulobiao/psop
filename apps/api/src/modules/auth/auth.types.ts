import type { Request } from 'express';

export interface AuthUser {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER';
  mustChangePassword: boolean;
  mfaEnabled: boolean;
}

export interface JwtPayload {
  sub: string;
  sid: string;
  jti: string;
  organizationId: string;
  email: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER';
  type: 'access';
}

export interface RefreshJwtPayload {
  sub: string;
  sid: string;
  jti: string;
  type: 'refresh';
}

export type AuthChallengeStage =
  | 'PASSWORD_CHANGE'
  | 'MFA';

export interface AuthChallengePayload {
  sub: string;
  cid: string;
  jti: string;
  stage: AuthChallengeStage;
  type: 'auth_challenge';
}

export interface SessionContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthenticatedRequest
  extends Request {
  user: AuthUser;
  sessionId: string;
}

export interface AuthenticatedAuthResult {
  stage: 'AUTHENTICATED';
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface PendingAuthResult {
  stage:
    | 'PASSWORD_CHANGE_REQUIRED'
    | 'MFA_REQUIRED';
  challengeToken: string;
  user: {
    name: string;
    email: string;
  };
}

export type AuthFlowResult =
  | AuthenticatedAuthResult
  | PendingAuthResult;
