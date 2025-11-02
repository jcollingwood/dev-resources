#if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
#  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
#fi

export ZSH="$HOME/.oh-my-zsh"

# Standard plugins can be found in $ZSH/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
plugins=(
	git
	asdf
	vi-mode
)

# load local bin to path - mainly for goose?
export PATH="$HOME/.local/bin:$PATH"


# include(): source if exists
include () {
	[[ -f "$1" ]] && source "$1"
}
source $ZSH/oh-my-zsh.sh
include $HOME/.shell_profiles/.barrel
include $HOME/.shell_profiles/.env

# . ~/.asdf/plugins/java/set-java-home.zsh

# alias for starting kanata with config with custom key mappings
alias kanata="sudo ~/.cargo/bin/kanata -c ~/.config/kanata/config.kbd"

# autocorrect package aliasj
# if thefuck is installed, alias `fix` to run it
if [ -x "$(command -v thefuck)" ]; then
	eval $(thefuck --alias fix)
fi

source <(fzf --zsh)

# to switch to starship instead of p10k
eval "$(starship init zsh)"

#THIS MUST BE AT THE END OF THE FILE FOR SDKMAN TO WORK!!!
export SDKMAN_DIR="$HOME/.sdkman"
[[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"

# opencode
export PATH=/home/joel/.opencode/bin:$PATH

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
