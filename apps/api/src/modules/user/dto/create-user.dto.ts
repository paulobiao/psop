import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(12)
  password!: string;

  @IsIn(['ADMIN', 'OPERATOR', 'VIEWER'])
  role!: 'ADMIN' | 'OPERATOR' | 'VIEWER';
}
