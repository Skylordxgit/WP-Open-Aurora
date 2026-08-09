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
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  getDashboard() {
    return this.omegaAdminService.getDashboardSummary();
  }

  @Get('usage')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  getUsage() {
    return this.omegaAdminService.getUsageOverview();
  }

  @Get('admin/settings')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  getSettings() {
    return this.omegaAdminService.getSettings();
  }

  @Get('clients')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  listClients() {
    return this.omegaAdminService.listClients();
  }

  @Post('clients')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  createClient(@Body() dto: CreateOmegaClientDto) {
    return this.omegaAdminService.createClient(dto);
  }

  @Get('clients/:id')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  getClient(@Param('id') id: string) {
    return this.omegaAdminService.getClientById(id);
  }

  @Get('clients/:clientId/sessions')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  getClientSessions(@Param('clientId') clientId: string) {
    return this.omegaAdminService.getClientSessions(clientId);
  }

  @Get('clients/:clientId/usage')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  getClientUsage(@Param('clientId') clientId: string) {
    return this.omegaAdminService.getClientUsage(clientId);
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
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  listSessions(@Query('status') status?: string, @Query('clientId') clientId?: string) {
    return this.omegaAdminService.listSessions({ status, clientId });
  }

  @Post('sessions/sync')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  syncSessions() {
    return this.omegaAdminService.syncSessions();
  }

  @Post('sessions/:id/assign')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  assignSession(@Param('id') id: string, @Body() dto: AssignOmegaSessionDto, @CurrentOmegaUser() user: OmegaUser) {
    return this.omegaAdminService.assignSession(id, dto, user.role);
  }

  @Post('sessions/:id/unassign')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  unassignSession(@Param('id') id: string) {
    return this.omegaAdminService.unassignSession(id);
  }

  @Patch('sessions/:id/replacement')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  updateReplacement(@Param('id') id: string, @Body() dto: UpdateOmegaSessionReplacementDto) {
    return this.omegaAdminService.updateReplacementFlag(id, dto.replacementRequested);
  }

  @Get('users')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN)
  listUsers() {
    return this.omegaAdminService.listUsers();
  }

  @Post('users')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN)
  createUser(@Body() dto: CreateOmegaUserDto) {
    return this.omegaAdminService.createUser(dto);
  }

  @Patch('users/:id')
  @RequireOmegaRoles(OmegaUserRole.SUPER_ADMIN)
  updateUser(@Param('id') id: string, @Body() dto: UpdateOmegaUserDto) {
    return this.omegaAdminService.updateUser(id, dto);
  }
}
