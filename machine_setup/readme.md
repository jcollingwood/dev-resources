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

#### Neovim (TODO maybe update to include install from source instructions)
```
sudo apt install neovim
```

#### Dotfiles
I like to keep all of my projects in a `workspaces` directory in my `root` directory.

```
mkdir workspace
git clone git@github.com:jcollingwood/dev-resources.git
```

Stow is a tool to help manage symlinking dotfiles.

note: must provide target to home directory, otherwise stow will symlink into parent directory
```
sudo apt install stow
stow [package_name] --target=/home/joel

stow alacritty --target=/home/joel
stow zsh --target=/home/joel
```


## Gaming Setup

### Steam 
```
sudo apt install steam
```

Enable proton via steam settings:

Settings > Compatibility > Enable Steam Play for all other titles

