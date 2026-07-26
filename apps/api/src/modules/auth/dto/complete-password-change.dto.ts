import {
  IsString,
  MinLength,
} from 'class-validator';

export class CompletePasswordChangeDto {
  @IsString()
  challengeToken!: string;

  @IsString()
  @MinLength(12)
  newPassword!: string;
}
