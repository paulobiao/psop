import { IsBoolean, IsNotEmpty, IsString } from 'class-validator';

export class CreateSiteDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  timezone!: string;

  @IsBoolean()
  isActive!: boolean;
}
