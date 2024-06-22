import { Injectable } from '@nestjs/common';
import { PrismaService } from '@@core/prisma/prisma.service';
import { LoggerService } from '@@core/logger/logger.service';
import { v4 as uuidv4 } from 'uuid';
import {
  UnifiedApplicationInput,
  UnifiedApplicationOutput,
} from '../types/model.unified';
import { FieldMappingService } from '@@core/field-mapping/field-mapping.service';
import { ServiceRegistry } from './registry.service';
import { WebhookService } from '@@core/webhook/webhook.service';
import { ApiResponse } from '@@core/utils/types';
import { OriginalApplicationOutput } from '@@core/utils/types/original/original.ats';
import { IApplicationService } from '../types';
import { CoreUnification } from '@@core/utils/services/core.service';
import { AtsObject } from '@ats/@lib/@types';

@Injectable()
export class ApplicationService {
  constructor(
    private prisma: PrismaService,
    private logger: LoggerService,
    private webhook: WebhookService,
    private fieldMappingService: FieldMappingService,
    private serviceRegistry: ServiceRegistry,
    private coreUnification: CoreUnification,
  ) {
    this.logger.setContext(ApplicationService.name);
  }

  async addApplication(
    unifiedApplicationData: UnifiedApplicationInput,
    integrationId: string,
    linkedUserId: string,
    remote_data?: boolean,
  ): Promise<UnifiedApplicationOutput> {
    try {
      const linkedUser = await this.prisma.linked_users.findUnique({
        where: { id_linked_user: linkedUserId },
      });

      const customFieldMappings =
        await this.fieldMappingService.getCustomFieldMappings(
          integrationId,
          linkedUserId,
          'ats.application',
        );

      const desunifiedObject =
        await this.coreUnification.desunify<UnifiedApplicationInput>({
          sourceObject: unifiedApplicationData,
          targetType: AtsObject.application,
          providerName: integrationId,
          vertical: 'ats',
          customFieldMappings: unifiedApplicationData.field_mappings
            ? customFieldMappings
            : [],
        });

      const service = this.serviceRegistry.getService(
        integrationId,
      ) as IApplicationService;
      const resp: ApiResponse<OriginalApplicationOutput> =
        await service.addApplication(desunifiedObject, linkedUserId);

      const unifiedObject = (await this.coreUnification.unify<
        OriginalApplicationOutput[]
      >({
        sourceObject: [resp.data],
        targetType: AtsObject.application,
        providerName: integrationId,
        vertical: 'ats',
        customFieldMappings: customFieldMappings,
      })) as UnifiedApplicationOutput[];

      const source_application = resp.data;
      const target_application = unifiedObject[0];

      const existingApplication = await this.prisma.ats_applications.findFirst({
        where: {
          remote_id: target_application.remote_id,
          remote_platform: integrationId,
          id_linked_user: linkedUserId,
        },
      });

      let unique_ats_application_id: string;

      if (existingApplication) {
        const data: any = {
          applied_at: target_application.applied_at,
          rejected_at: target_application.rejected_at,
          offers: target_application.offers,
          source: target_application.source,
          credited_to: target_application.credited_to,
          current_stage: target_application.current_stage,
          reject_reason: target_application.reject_reason,
          modified_at: new Date(),
        };

        const res = await this.prisma.ats_applications.update({
          where: { id_ats_application: existingApplication.id_ats_application },
          data: data,
        });

        unique_ats_application_id = res.id_ats_application;
      } else {
        const data: any = {
          id_ats_application: uuidv4(),
          applied_at: target_application.applied_at,
          rejected_at: target_application.rejected_at,
          offers: target_application.offers,
          source: target_application.source,
          credited_to: target_application.credited_to,
          current_stage: target_application.current_stage,
          reject_reason: target_application.reject_reason,
          created_at: new Date(),
          modified_at: new Date(),
          id_linked_user: linkedUserId,
          remote_id: target_application.remote_id,
          remote_platform: integrationId,
        };

        const newApplication = await this.prisma.ats_applications.create({
          data: data,
        });

        unique_ats_application_id = newApplication.id_ats_application;
      }

      if (target_application.candidate_id) {
        await this.prisma.ats_applications.update({
          where: {
            id_ats_application: unique_ats_application_id,
          },
          data: {
            id_ats_candidate: target_application.candidate_id,
          },
        });
      }
      if (target_application.job_id) {
        await this.prisma.ats_applications.update({
          where: {
            id_ats_application: unique_ats_application_id,
          },
          data: {
            id_ats_job: target_application.job_id,
          },
        });
      }
      if (
        target_application.field_mappings &&
        target_application.field_mappings.length > 0
      ) {
        const entity = await this.prisma.entity.create({
          data: {
            id_entity: uuidv4(),
            ressource_owner_id: unique_ats_application_id,
          },
        });

        for (const [slug, value] of Object.entries(
          target_application.field_mappings,
        )) {
          const attribute = await this.prisma.attribute.findFirst({
            where: {
              slug: slug,
              source: integrationId,
              id_consumer: linkedUserId,
            },
          });

          if (attribute) {
            await this.prisma.value.create({
              data: {
                id_value: uuidv4(),
                data: value || 'null',
                attribute: {
                  connect: { id_attribute: attribute.id_attribute },
                },
                entity: { connect: { id_entity: entity.id_entity } },
              },
            });
          }
        }
      }

      await this.prisma.remote_data.upsert({
        where: { ressource_owner_id: unique_ats_application_id },
        create: {
          id_remote_data: uuidv4(),
          ressource_owner_id: unique_ats_application_id,
          format: 'json',
          data: JSON.stringify(source_application),
          created_at: new Date(),
        },
        update: {
          data: JSON.stringify(source_application),
          created_at: new Date(),
        },
      });

      const result_application = await this.getApplication(
        unique_ats_application_id,
        remote_data,
      );

      const status_resp = resp.statusCode === 201 ? 'success' : 'fail';
      const event = await this.prisma.events.create({
        data: {
          id_event: uuidv4(),
          status: status_resp,
          type: 'ats.application.created',
          method: 'POST',
          url: '/ats/applications',
          provider: integrationId,
          direction: '0',
          timestamp: new Date(),
          id_linked_user: linkedUserId,
        },
      });
      await this.webhook.handleWebhook(
        result_application,
        'ats.application.created',
        linkedUser.id_project,
        event.id_event,
      );
      return result_application;
    } catch (error) {
      throw error;
    }
  }

  async getApplication(
    id_ats_application: string,
    remote_data?: boolean,
  ): Promise<UnifiedApplicationOutput> {
    try {
      const application = await this.prisma.ats_applications.findUnique({
        where: { id_ats_application: id_ats_application },
      });

      const values = await this.prisma.value.findMany({
        where: {
          entity: { ressource_owner_id: application.id_ats_application },
        },
        include: { attribute: true },
      });

      const fieldMappingsMap = new Map();
      values.forEach((value) => {
        fieldMappingsMap.set(value.attribute.slug, value.data);
      });

      const field_mappings = Array.from(fieldMappingsMap, ([key, value]) => ({
        [key]: value,
      }));

      const unifiedApplication: UnifiedApplicationOutput = {
        id: application.id_ats_application,
        applied_at: application.applied_at,
        rejected_at: application.rejected_at,
        offers: application.offers,
        source: application.source,
        credited_to: application.credited_to,
        current_stage: application.current_stage,
        reject_reason: application.reject_reason,
        candidate_id: application.id_ats_candidate,
        job_id: application.id_ats_job,
        field_mappings: field_mappings,
      };

      let res: UnifiedApplicationOutput = unifiedApplication;
      if (remote_data) {
        const resp = await this.prisma.remote_data.findFirst({
          where: { ressource_owner_id: application.id_ats_application },
        });
        const remote_data = JSON.parse(resp.data);

        res = {
          ...res,
          remote_data: remote_data,
        };
      }

      return res;
    } catch (error) {
      throw error;
    }
  }

  async getApplications(
    integrationId: string,
    linkedUserId: string,
    limit: number,
    remote_data?: boolean,
    cursor?: string,
  ): Promise<{
    data: UnifiedApplicationOutput[];
    prev_cursor: null | string;
    next_cursor: null | string;
  }> {
    try {
      let prev_cursor = null;
      let next_cursor = null;

      if (cursor) {
        const isCursorPresent = await this.prisma.ats_applications.findFirst({
          where: {
            remote_platform: integrationId.toLowerCase(),
            id_linked_user: linkedUserId,
            id_ats_application: cursor,
          },
        });
        if (!isCursorPresent) {
          throw new ReferenceError(`The provided cursor does not exist!`);
        }
      }

      const applications = await this.prisma.ats_applications.findMany({
        take: limit + 1,
        cursor: cursor ? { id_ats_application: cursor } : undefined,
        orderBy: { created_at: 'asc' },
        where: {
          remote_platform: integrationId.toLowerCase(),
          id_linked_user: linkedUserId,
        },
      });

      if (applications.length === limit + 1) {
        next_cursor = Buffer.from(
          applications[applications.length - 1].id_ats_application,
        ).toString('base64');
        applications.pop();
      }

      if (cursor) {
        prev_cursor = Buffer.from(cursor).toString('base64');
      }

      const unifiedApplications: UnifiedApplicationOutput[] = await Promise.all(
        applications.map(async (application) => {
          const values = await this.prisma.value.findMany({
            where: {
              entity: { ressource_owner_id: application.id_ats_application },
            },
            include: { attribute: true },
          });

          const fieldMappingsMap = new Map();
          values.forEach((value) => {
            fieldMappingsMap.set(value.attribute.slug, value.data);
          });

          const field_mappings = Array.from(
            fieldMappingsMap,
            ([key, value]) => ({ [key]: value }),
          );

          return {
            id: application.id_ats_application,
            applied_at: application.applied_at,
            rejected_at: application.rejected_at,
            offers: application.offers,
            source: application.source,
            credited_to: application.credited_to,
            current_stage: application.current_stage,
            reject_reason: application.reject_reason,
            candidate_id: application.id_ats_candidate,
            job_id: application.id_ats_job,
            field_mappings: field_mappings,
          };
        }),
      );

      let res: UnifiedApplicationOutput[] = unifiedApplications;

      if (remote_data) {
        const remote_array_data: UnifiedApplicationOutput[] = await Promise.all(
          res.map(async (application) => {
            const resp = await this.prisma.remote_data.findFirst({
              where: { ressource_owner_id: application.id },
            });
            const remote_data = JSON.parse(resp.data);
            return { ...application, remote_data };
          }),
        );

        res = remote_array_data;
      }

      const event = await this.prisma.events.create({
        data: {
          id_event: uuidv4(),
          status: 'success',
          type: 'ats.application.pull',
          method: 'GET',
          url: '/ats/applications',
          provider: integrationId,
          direction: '0',
          timestamp: new Date(),
          id_linked_user: linkedUserId,
        },
      });

      return { data: res, prev_cursor, next_cursor };
    } catch (error) {
      throw error;
    }
  }

  async updateApplication(
    id: string,
    updateApplicationData: Partial<UnifiedApplicationInput>,
  ): Promise<UnifiedApplicationOutput> {
    try {
      // TODO: fetch the application from the database using 'id'
      // TODO: update the application with 'updateApplicationData'
      // TODO: save the updated application back to the database
      // TODO: return the updated application
      return;
    } catch (error) {
      throw error;
    }
  }
}
