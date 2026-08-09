import { IsNotEmpty, IsString } from 'class-validator';

export class HelloDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}
