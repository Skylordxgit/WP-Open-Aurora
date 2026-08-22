import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageService } from './storage.service';
import { MediaArchiveService } from '../media/media-archive.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [StorageService, MediaArchiveService],
  exports: [StorageService, MediaArchiveService],
})
export class StorageModule {}
