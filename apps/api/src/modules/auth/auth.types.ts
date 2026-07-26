import type { Request } from 'express';

export interface AuthUser {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER';
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

export interface SessionContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
  sessionId: string;
}
