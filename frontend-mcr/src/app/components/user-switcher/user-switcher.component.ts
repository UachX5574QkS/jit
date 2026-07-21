import { Component, inject, OnInit } from '@angular/core';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { AuthService } from '../../services/auth.service';
import { UserService } from '../../services/user.service';

interface User {
  user_id: number;
  username: string;
  display_name: string;
  email: string;
}

@Component({
  selector: 'app-user-switcher',
  standalone: true,
  imports: [MatSelectModule, MatFormFieldModule],
  templateUrl: './user-switcher.component.html',
  styleUrl: './user-switcher.component.scss'
})
export class UserSwitcherComponent implements OnInit {
  private readonly userService = inject(UserService);
  readonly authService = inject(AuthService);

  users: User[] = [];

  ngOnInit(): void {
    this.userService.getUsers().subscribe({
      next: (users) => {
        this.users = users;
      },
      error: () => {
        this.users = [];
      }
    });
  }

  onUserChange(userId: number): void {
    this.authService.switchUser(userId);
  }
}
