# Terminal Configuration

These are just the basic setup instructions to set up my current dev terminal preferences

Install zsh : https://github.com/ohmyzsh/ohmyzsh/wiki/Installing-ZSH

Install OhMyZsh : https://ohmyz.sh/#install

OhMyZsh Customizations in `~/.zshrc` : 

```shell
ZSH_THEME="eastwood"

unsetopt share_history
setopt no_share_history

plugins=(
   git
   history
   docker
)
```

I keep all of my terminal dot customization files in `~/.shell_profiles` and export configurations via a `.barrel` file to only require this single addition to the `~/.zsshrc` file :

```shell
source $HOME/.shell_profiles/.barrel
```

Terminal dot customization files located in this directory :

`.git_profiles` : git terminal shortcuts that I use... will probably run into naming collision eventually but so far so good
