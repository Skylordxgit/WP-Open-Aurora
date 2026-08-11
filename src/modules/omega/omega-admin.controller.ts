import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipApiKeyAuth } from '../auth/decorators/auth.decorators';
import { CurrentOmegaUser, RequireOmegaRoles } from './decorators/omega-auth.decorators';
import {
  AssignOmegaSessionDto,
  CreateOmegaClientDto,
  CreateOmegaPlanDto,
  CreateOmegaUserDto,
  UpdateOmegaSessionReplacementDto,
  UpdateOmegaClientDto,
  UpdateOmegaPlanDto,
  UpdateOmegaUserDto,
} from './dto';
import { OmegaUser, OmegaUserRole } from './entities';
import { OmegaAuthGuard } from './guards/omega-auth.guard';
import { OmegaRolesGuard } from './guards/omega-roles.guard';
import { OmegaAdminService } from './omega-admin.service';

@ApiTags('omega-admin')
@Controller('omega')
@SkipApiKeyAuth()
@UseGuards(OmegaAuthGuard, OmegaRolesGuard)
export class OmegaAdminController {
  constructor(private readonly omegaAdminService: OmegaAdminService) {}

  @Get('admin/dashboard')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  getDashboard(@CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.getDashboardSummary(user);
  }

  @Get('usage')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  getUsage(@CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.getUsageOverview(user);
  }

  @Get('admin/settings')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  getSettings() {
    return this.omegaAdminService.getSettings();
  }

  @Get('clients')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  listClients(@CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.listClients(user);
  }

  @Post('clients')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  createClient(@Body() dto: CreateOmegaClientDto) {
    return this.omegaAdminService.createClient(dto);
  }

  @Get('clients/:id')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  getClient(@Param('id') id: string, @CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.getClientById(id, user);
  }

  @Get('clients/:clientId/sessions')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  getClientSessions(@Param('clientId') clientId: string, @CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.getClientSessions(clientId, user);
  }

  @Get('clients/:clientId/usage')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  getClientUsage(@Param('clientId') clientId: string, @CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.getClientUsage(clientId, user);
  }

  @Patch('clients/:id')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  updateClient(@Param('id') id: string, @Body() dto: UpdateOmegaClientDto) {
    return this.omegaAdminService.updateClient(id, dto);
  }

  @Get('plans')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  listPlans() {
    return this.omegaAdminService.listPlans();
  }

  @Post('plans')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN)
  createPlan(@Body() dto: CreateOmegaPlanDto) {
    return this.omegaAdminService.createPlan(dto);
  }

  @Patch('plans/:id')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN)
  updatePlan(@Param('id') id: string, @Body() dto: UpdateOmegaPlanDto) {
    return this.omegaAdminService.updatePlan(id, dto);
  }

  @Get('sessions')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  listSessions(
    @CurrentOmegaUser() user: OmegaUser,
    @Query('status') status?: string,
    @Query('clientId') clientId?: string,
  ) {
    return this.omegaAdminService.listSessions({ status, clientId }, user);
  }

  @Post('sessions/sync')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  syncSessions(@CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.syncSessions(user);
  }

  @Post('sessions/:id/assign')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  assignSession(@Param('id') id: string, @Body() dto: AssignOmegaSessionDto, @CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.assignSession(id, dto, user);
  }

  @Post('sessions/:id/unassign')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  unassignSession(@Param('id') id: string, @CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.unassignSession(id, user);
  }

  @Patch('sessions/:id/replacement')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  updateReplacement(
    @Param('id') id: string,
    @Body() dto: UpdateOmegaSessionReplacementDto,
    @CurrentOmegaUser() user: OmegaUser,
  ) {
    return this.omegaAdminService.updateReplacementFlag(id, dto.replacementRequested, user);
  }

  @Get('users')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  listUsers(@CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.listUsers(user);
  }

  @Post('users')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  createUser(@Body() dto: CreateOmegaUserDto, @CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.createUser(dto, user);
  }

  @Patch('users/:id')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN, OmegaUserRole.CLIENT_ADMIN)
  updateUser(@Param('id') id: string, @Body() dto: UpdateOmegaUserDto, @CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.updateUser(id, dto, user);
  }
}
