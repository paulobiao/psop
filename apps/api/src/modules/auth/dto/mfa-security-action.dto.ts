import {
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class MfaSecurityActionDto {
  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(32)
  code!: string;
}
