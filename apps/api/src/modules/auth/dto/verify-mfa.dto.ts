import {
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class VerifyMfaDto {
  @IsString()
  challengeToken!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(32)
  code!: string;
}
