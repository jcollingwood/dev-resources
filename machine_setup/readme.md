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
sudo mv $(ls | JetBrains) /usr/local/share/fonts
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
- [powerlevel10k](https://github.com/romkatv/powerlevel10k?tab=readme-ov-file#installation)


#### Rust/cargo (required for certain dependencies
```
curl https://sh.rustup.rs -sSf | sh
sudo apt install cargo
```

#### Alacritty [install docs](https://github.com/alacritty/alacritty/blob/master/INSTALL.md)

- I install alacritty via Cargo to get the latest version which uses the latest toml configuration. Default apt alacrity is older and not compatible with toml config
- After installation, it took some work setting up cargo-installed alacritty as a recognized desktop application to launch with launcher and with os terminal shortcuts

```
# install required deps (Ubuntu example provided)
apt install cmake pkg-config libfreetype6-dev libfontconfig1-dev libxcb-xfixes0-dev libxkbcommon-dev python3
cargo install alacritty
```

#### Zellij download steps ([zellij docs](https://zellij.dev/documentation/installation))
Note: rust/cargo installation required first
```
cargo install --locked zellij
# restart terminal to use zellij from path
```

#### Vim

```
sudo apt install vim
# TODO add additional vim plugin deps as needed
```

#### [Neovim](https://github.com/neovim/neovim/blob/master/INSTALL.md) 

note: have been using pure vim in place of neovim recently until need for nvim plugins becomes necessary
note: apt neovim is old, so installing newer version manually, confirm these 3 instructions below are still current

```
# sudo apt install neovim
sudo apt-get install ninja-build gettext cmake unzip curl build-essential
make CMAKE_BUILD_TYPE=Release
sudo make install
# additional dependencies as needed
sudo apt install ripgrep
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
stow zsh
stow vim
# stow nvim # currently broken, update if using nvim
```

[Intellij CE](https://www.jetbrains.com/toolbox-app/)


## Gaming Setup

### Steam 
```
sudo apt install steam
```

Enable proton via steam settings:

Settings > Compatibility > Enable Steam Play for all other titles

