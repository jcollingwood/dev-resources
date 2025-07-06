# Initial New Machine Setup

## Git setup

Generate ssh key for machine:
```
ssh-keygen -t ed25519 -C "joelcollingwood93@gmail.com"
```

On github: 

Profile > Settings > SSH and GPG keys > New SSH key > name: 'jc_{machine identifier}_ssh_key'

e.g. `jc_xps_ssh_key`, `jc_desktop_pop_ssh_key`


Install git:
```
sudo apt install git
```

## Local Environment Setup

### Tools

#### Fonts
[Nerd Font Dowloads](https://www.nerdfonts.com/)

Install desired fonts (should show up in `/Downloads` dir as zips.

```
cd ~/Donwloads
which unzip # should be installed
unzip JetBrainsMono.zip
# this will move all unzipped font .ttf files containing 'JetBrains' into the shared fonts directory
# may need to create this directory first...
sudo mv $(ls | grep JetBrains) /usr/local/share/fonts
# refresh font cache
fc-cache -f -v
# list fonts (optionally grep with name of desired fonts to verify in list)
fc-list | grep JetBrains
```

To update os system font, need gnome-tweaks depdency
```
sudo apt install gnome-tweaks
```

#### zshell
```
sudo apt install zsh
chsh -s $(which zsh)
```
note: log out and back in to see zsh set as default shell

#### ohmyzsh setup:

This should all be completed and handled by the provided config file and work once config is referenced and set up. See [ohmyzsh docs](https://ohmyz.sh/) for setup instructions

A few notes on preferred plugins, themes, and options:

Plugins:
- git


Themes:
- (old) [powerlevel10k](https://github.com/romkatv/powerlevel10k?tab=readme-ov-file#installation)
- [starship](https://starship.rs/guide/)

```
# sets pure prompt as starship default
starship preset pure-preset -o ~/.config/starship.toml
# todo explore more prompt customizations
```


#### Rust/cargo (required for certain dependencies)
```
curl https://sh.rustup.rs -sSf | sh
sudo apt install cargo
```

#### Alacritty [install docs](https://github.com/alacritty/alacritty/blob/master/INSTALL.md)

- on more recent distros like Fedora, just install via package manager: `sudo dnf install alacritty`
- I install alacritty via Cargo to get the latest version which uses the latest toml configuration. Default apt alacrity is older and not compatible with toml config
- After installation, it took some work setting up cargo-installed alacritty as a recognized desktop application to launch with launcher and with os terminal shortcuts

```
# install required deps (Ubuntu example provided)
apt install cmake pkg-config libfreetype6-dev libfontconfig1-dev libxcb-xfixes0-dev libxkbcommon-dev python3
cargo install alacritty
```

#### Zellij download steps ([zellij docs](https://zellij.dev/documentation/installation))
Note: rust/cargo installation required first
Note: on Fedora, had to `sudo dnf install perl-core` dependency first
```
cargo install --locked zellij
# restart terminal to use zellij from path
```

#### Vim

```
sudo apt install vim
# vim plug used to manage plugins
# after running stow vim from dotfiles, run :PlugInstall from vim to install and enable all plugins and restart vim
# note: depending on the system and version of vim, yank to clipboard may not work by default, if so run this command:
sudo apt install vim-gtk
```

#### [Neovim](https://github.com/neovim/neovim/blob/master/INSTALL.md) 

note: have been using pure vim in place of neovim recently until need for nvim plugins becomes necessary
note: apt neovim is old, so installing newer version manually, confirm these 3 instructions below are still current

```
# sudo apt install neovim
sudo apt-get install ninja-build gettext cmake unzip curl build-essential
make CMAKE_BUILD_TYPE=Release
sudo make install
# additional dependencies
sudo apt install ripgrep
```

#### [Kanata](https://github.com/jtroo/kanata?tab=readme-ov-file)

key remapping software, use common configuration across different devices/OSes

basic option to set up and install with cargo:
```
cargo install kanata
# to start kanata remapp, assuming config stowed (see below)
sudo ~/.cargo/bin/kanata -c ~/.config/kanata/config.kbd
# todo document steps to start kanata on startup
```

alternate way I'm working on just downloading the kanata executable and moving to the `/etc/bin/kanata` location.

```
# add setup commands if figured out systemctl start 
``` 

system configuration to run kanata on startup and/or in the background
```service
[Unit]
Description=Kanata Service
Requires=local-fs.target
After=local-fs.target

[Service]
ExecStartPre=/usr/bin/modprobe uinput
ExecStart=/home/joel/.cargo/bin/kanata -c /home/joel/.config/kanata/config.kbd
Restart=no

[Install]
WantedBy=sysinit.target
```

#### [thefuck](https://github.com/nvbn/thefuck)

auto-fix typo or fat-fingered terminal commands or provides the correct terminal command for whatever I just botched.
note: might as well try to be professional, aliased to `fix` in .zshrc

```bash
sudo dnf install thefuck
```

#### [fzf](https://github.com/junegunn/fzf)

fuzzy find cli thing

```bash
sudo dnf install fzf
```

#### Dotfiles
I like to keep all of my projects in a `workspaces` directory in my `root` directory.

```
mkdir workspace
git clone git@github.com:jcollingwood/dev-resources.git
```

Stow is a tool to help manage symlinking dotfiles.

note: default target directory of `/home/joel` is provided in `.stowrc` located in dotfiles directory, as needed update that file or override manually with `--target=/path/to/home`

nvim config is based on [kickstart](https://github.com/nvim-lua/kickstart.nvim/tree/master)

```
sudo apt install stow
# must run stow from dotfile directory
cd ~/workspace/dev-resources/machine_setup/dotfiles
# validate default target home path matches expectation
cat .stowrc
# default output: --target=/home/joel
stow [package_name] 


stow alacritty
# for zsh need p10k installed
git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ~/powerlevel10k
stow zsh
stow vim
stow kanata
# stow nvim # currently broken, update if using nvim
stow zellij
```

## [Docker](https://docs.docker.com/engine/install/fedora/)

- tbh, just go to docker's site and follow their installation instructions

```bash
# to start/stop docker manually
sudo systemctl start docker
sudo systemctl stop docker
# to start docker automatically on system startup
sudo systemctl enable --now docker
```

### [ASDF](https://asdf-vm.com/guide/getting-started.html)

Tool manager for many languages. Default zsh plugin for autocompletion is in the `.zshrc` already. See how to configure plugins below

Note: working on evaluating best for distros like Fedora

Java:

```
asdf plugin-add java https://github.com/halcyon/asdf-java.git
asdf install java corretto-21.0.4.7.1
```

Gradle
```
asdf plugin-add gradle https://github.com/rfrancis/asdf-gradle.git
asdf install gradle 
```

### [Intellij CE](https://www.jetbrains.com/toolbox-app/)

### [VS Code](https://code.visualstudio.com/)

### [Android Studio](https://developer.android.com/studio/install)

note: see docs for required dependencies install for distro

### [GIMP](https://www.gimp.org/)

### ... TODO


## Gaming Setup

### Steam 
```
sudo apt install steam
```

Enable proton via steam settings:

Settings > Compatibility > Enable Steam Play for all other titles

