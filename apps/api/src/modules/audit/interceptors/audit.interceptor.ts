import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import {
  mergeMap,
  type Observable,
} from 'rxjs';
import type { AuthUser } from '../../auth/auth.types.js';
import { AuditService } from '../services/audit.service.js';

interface AuditRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  ip?: string;
  body?: unknown;
  params?: Record<string, string>;
  user?: AuthUser;
  headers: Record<
    string,
    string | string[] | undefined
  >;
}

interface AuditResponse {
  statusCode: number;
}

@Injectable()
export class AuditInterceptor
  implements NestInterceptor
{
  constructor(
    private readonly auditService: AuditService,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<AuditRequest>();

    const response = context
      .switchToHttp()
      .getResponse<AuditResponse>();

    const user = request.user;
    const method = request.method.toUpperCase();

    if (
      !user ||
      !['POST', 'PUT', 'PATCH', 'DELETE'].includes(
        method,
      )
    ) {
      return next.handle();
    }

    const path =
      request.originalUrl ??
      request.url ??
      '';

    const startedAt = Date.now();

    return next.handle().pipe(
      mergeMap(async (responseBody: unknown) => {
        const entityType =
          this.resolveEntityType(path);

        await this.auditService.record({
          organizationId: user.organizationId,
          actorUserId: user.id,
          actorName: user.name,
          actorEmail: user.email,
          actorRole: user.role,
          action: this.resolveAction(
            method,
            path,
            entityType,
          ),
          entityType,
          entityId: this.resolveEntityId(
            request,
            responseBody,
          ),
          method,
          path,
          statusCode: response.statusCode,
          ipAddress: request.ip,
          userAgent: this.headerValue(
            request.headers['user-agent'],
          ),
          metadata: {
            durationMs: Date.now() - startedAt,
            request: this.sanitize(request.body),
            response:
              this.summarizeResponse(responseBody),
          },
        });

        return responseBody;
      }),
    );
  }

  private resolveEntityType(path: string): string {
    const cleanPath = path.split('?')[0];

    if (
      cleanPath.includes('/auth/sessions') ||
      cleanPath.includes('/auth/users/') &&
        cleanPath.endsWith('/sessions') ||
      cleanPath.endsWith('/auth/logout') ||
      cleanPath.endsWith('/auth/logout-all')
    ) {
      return 'SESSION';
    }

    const segments = path
      .split('?')[0]
      .split('/')
      .filter(Boolean);

    const versionIndex = segments.findIndex(
      (segment) => /^v\d+$/.test(segment),
    );

    const resource =
      versionIndex >= 0
        ? segments[versionIndex + 1]
        : segments.at(-1);

    const mapping: Record<string, string> = {
      users: 'USER',
      sites: 'SITE',
      devices: 'DEVICE',
      alerts: 'ALERT',
      organizations: 'ORGANIZATION',
      operations: 'OPERATION',
    };

    return mapping[resource ?? ''] ?? 'SYSTEM';
  }

  private resolveAction(
    method: string,
    path: string,
    entityType: string,
  ): string {
    const cleanPath = path.split('?')[0];

    if (
      entityType === 'SESSION' &&
      cleanPath.endsWith('/logout-all')
    ) {
      return 'SESSIONS_REVOKED';
    }

    if (
      entityType === 'SESSION' &&
      (
        cleanPath.endsWith('/logout') ||
        method === 'DELETE'
      )
    ) {
      return 'SESSION_REVOKED';
    }

    if (
      entityType === 'USER' &&
      cleanPath.endsWith('/password')
    ) {
      return 'USER_PASSWORD_CHANGED';
    }

    if (
      entityType === 'ALERT' &&
      cleanPath.endsWith('/resolve')
    ) {
      return 'ALERT_RESOLVED';
    }

    if (cleanPath.endsWith('/evaluate')) {
      return `${entityType}_EVALUATED`;
    }

    const verbs: Record<string, string> = {
      POST: 'CREATED',
      PUT: 'UPDATED',
      PATCH: 'UPDATED',
      DELETE: 'DELETED',
    };

    return `${entityType}_${
      verbs[method] ?? 'CHANGED'
    }`;
  }

  private resolveEntityId(
    request: AuditRequest,
    responseBody: unknown,
  ): string | undefined {
    if (
      responseBody &&
      typeof responseBody === 'object' &&
      !Array.isArray(responseBody)
    ) {
      const id = (
        responseBody as Record<string, unknown>
      ).id;

      if (typeof id === 'string') {
        return id;
      }
    }

    return request.params?.id;
  }

  private sanitize(value: unknown): unknown {
    if (
      value === null ||
      value === undefined ||
      typeof value !== 'object'
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) =>
        this.sanitize(item),
      );
    }

    return Object.fromEntries(
      Object.entries(
        value as Record<string, unknown>,
      ).map(([key, item]) => {
        const sensitive =
          /password|token|secret|authorization/i.test(
            key,
          );

        return [
          key,
          sensitive
            ? '[REDACTED]'
            : this.sanitize(item),
        ];
      }),
    );
  }

  private summarizeResponse(
    value: unknown,
  ): unknown {
    if (Array.isArray(value)) {
      return {
        count: value.length,
      };
    }

    if (
      !value ||
      typeof value !== 'object'
    ) {
      return value;
    }

    const source =
      value as Record<string, unknown>;

    const allowed = [
      'id',
      'name',
      'email',
      'role',
      'status',
      'title',
      'code',
      'externalId',
      'resolvedAt',
      'createdAt',
      'updatedAt',
    ];

    return Object.fromEntries(
      allowed
        .filter((key) => key in source)
        .map((key) => [key, source[key]]),
    );
  }

  private headerValue(
    value: string | string[] | undefined,
  ): string | undefined {
    return Array.isArray(value)
      ? value.join(', ')
      : value;
  }
}
